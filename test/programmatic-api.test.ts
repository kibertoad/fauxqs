import { describe, it, expect, afterEach } from "vitest";
import { startFauxqs, type FauxqsServer } from "../src/app.js";
import { createSqsClient, createSnsClient, createS3Client } from "./helpers/clients.js";
import {
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { CreateTopicCommand, ListTopicsCommand, ListSubscriptionsCommand, PublishCommand } from "@aws-sdk/client-sns";
import {
  ListBucketsCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

describe("programmatic API", () => {
  let server: FauxqsServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("createQueue makes queue visible via SDK and returns metadata", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    const { queueUrl, queueArn, queueName } = server.createQueue("prog-queue");

    expect(queueUrl).toContain("prog-queue");
    expect(queueArn).toMatch(/^arn:aws:sqs:.+:000000000000:prog-queue$/);
    expect(queueName).toBe("prog-queue");

    const sqs = createSqsClient(server.port);
    const result = await sqs.send(new ListQueuesCommand({}));
    expect(result.QueueUrls).toHaveLength(1);
    expect(result.QueueUrls![0]).toBe(queueUrl);
  });

  it("createQueue with attributes and tags returns metadata", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    const { queueUrl, queueArn } = server.createQueue("prog-queue-attrs", {
      attributes: { VisibilityTimeout: "120" },
      tags: { team: "platform" },
    });

    expect(queueUrl).toContain("prog-queue-attrs");
    expect(queueArn).toContain("prog-queue-attrs");

    const sqs = createSqsClient(server.port);
    const result = await sqs.send(new ListQueuesCommand({}));
    expect(result.QueueUrls).toHaveLength(1);
  });

  it("createTopic makes topic visible via SDK and returns topicArn", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    const { topicArn } = server.createTopic("prog-topic");

    expect(topicArn).toMatch(/^arn:aws:sns:.+:000000000000:prog-topic$/);

    const sns = createSnsClient(server.port);
    const result = await sns.send(new ListTopicsCommand({}));
    expect(result.Topics).toHaveLength(1);
    expect(result.Topics![0].TopicArn).toBe(topicArn);
  });

  it("createTopic with attributes and tags returns topicArn", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    const { topicArn } = server.createTopic("prog-topic-attrs", {
      attributes: { DisplayName: "My Topic" },
      tags: { team: "platform" },
    });

    expect(topicArn).toContain("prog-topic-attrs");

    const sns = createSnsClient(server.port);
    const result = await sns.send(new ListTopicsCommand({}));
    expect(result.Topics).toHaveLength(1);
  });

  it("subscribe wires topic to queue", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("sub-q");
    server.createTopic("sub-t");
    server.subscribe({ topic: "sub-t", queue: "sub-q" });

    const sns = createSnsClient(server.port);
    const subs = await sns.send(new ListSubscriptionsCommand({}));
    expect(subs.Subscriptions).toHaveLength(1);
    expect(subs.Subscriptions![0].Protocol).toBe("sqs");

    // Verify end-to-end: publish → receive
    await sns.send(
      new PublishCommand({
        TopicArn: "arn:aws:sns:us-east-1:000000000000:sub-t",
        Message: "programmatic test",
      }),
    );

    const sqs = createSqsClient(server.port);
    const queues = await sqs.send(new ListQueuesCommand({}));
    const msgs = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(msgs.Messages).toHaveLength(1);
    expect(msgs.Messages![0].Body).toContain("programmatic test");
  });

  it("createBucket makes bucket visible via SDK and returns metadata", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    const { bucketName } = server.createBucket("prog-bucket");

    expect(bucketName).toBe("prog-bucket");

    const s3 = createS3Client(server.port);
    const result = await s3.send(new ListBucketsCommand({}));
    expect(result.Buckets).toHaveLength(1);
    expect(result.Buckets![0].Name).toBe("prog-bucket");
  });

  it("setup creates all resources from config", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.setup({
      queues: [{ name: "setup-q1" }, { name: "setup-q2" }],
      topics: [{ name: "setup-t1" }],
      subscriptions: [{ topic: "setup-t1", queue: "setup-q1" }],
      buckets: ["setup-b1", "setup-b2"],
    });

    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(2);

    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics).toHaveLength(1);

    const subs = await sns.send(new ListSubscriptionsCommand({}));
    expect(subs.Subscriptions).toHaveLength(1);

    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets).toHaveLength(2);
  });

  it("purgeAll clears all resources", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("purge-q");
    server.createTopic("purge-t");
    server.createBucket("purge-b");

    server.purgeAll();

    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls ?? []).toHaveLength(0);

    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics ?? []).toHaveLength(0);

    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets ?? []).toHaveLength(0);
  });

  it("purgeAll then recreate works", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("first-q");
    server.purgeAll();
    server.createQueue("second-q");

    const sqs = createSqsClient(server.port);
    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(1);
    expect(queues.QueueUrls![0]).toContain("second-q");
  });

  describe("deleteQueue", () => {
    it("removes queue so it is no longer visible via SDK", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("del-q");

      const sqs = createSqsClient(server.port);
      const before = await sqs.send(new ListQueuesCommand({}));
      expect(before.QueueUrls).toHaveLength(1);

      server.deleteQueue("del-q");

      const after = await sqs.send(new ListQueuesCommand({}));
      expect(after.QueueUrls ?? []).toHaveLength(0);
    });

    it("is a no-op for non-existent queue", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      expect(() => server.deleteQueue("no-such-queue")).not.toThrow();
    });

    it("allows recreating deleted queue with different attributes", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("reconfig-q", { attributes: { VisibilityTimeout: "30" } });
      server.deleteQueue("reconfig-q");
      server.createQueue("reconfig-q", { attributes: { VisibilityTimeout: "120" } });

      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(new ListQueuesCommand({}));
      expect(queues.QueueUrls).toHaveLength(1);
    });
  });

  describe("deleteTopic", () => {
    it("removes topic so it is no longer visible via SDK", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createTopic("del-t");

      const sns = createSnsClient(server.port);
      const before = await sns.send(new ListTopicsCommand({}));
      expect(before.Topics).toHaveLength(1);

      server.deleteTopic("del-t");

      const after = await sns.send(new ListTopicsCommand({}));
      expect(after.Topics ?? []).toHaveLength(0);
    });

    it("removes associated subscriptions", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("del-sub-q");
      server.createTopic("del-sub-t");
      server.subscribe({ topic: "del-sub-t", queue: "del-sub-q" });

      server.deleteTopic("del-sub-t");

      const sns = createSnsClient(server.port);
      const subs = await sns.send(new ListSubscriptionsCommand({}));
      expect(subs.Subscriptions ?? []).toHaveLength(0);
    });

    it("is a no-op for non-existent topic", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      expect(() => server.deleteTopic("no-such-topic")).not.toThrow();
    });

    it("deletes topic created via SDK in a non-default region", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const sns = createSnsClient(server.port, "eu-west-1");
      await sns.send(new CreateTopicCommand({ Name: "eu-topic" }));

      const before = await sns.send(new ListTopicsCommand({}));
      expect(before.Topics).toHaveLength(1);

      server.deleteTopic("eu-topic", { region: "eu-west-1" });

      const after = await sns.send(new ListTopicsCommand({}));
      expect(after.Topics ?? []).toHaveLength(0);
    });

    it("does not delete topic in different region", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createTopic("region-t", { region: "eu-west-1" });
      server.createTopic("region-t", { region: "us-east-1" });

      server.deleteTopic("region-t", { region: "eu-west-1" });

      const sns = createSnsClient(server.port);
      const after = await sns.send(new ListTopicsCommand({}));
      expect(after.Topics).toHaveLength(1);
      expect(after.Topics![0].TopicArn).toContain("us-east-1");
    });
  });

  describe("emptyBucket", () => {
    it("removes all objects but keeps the bucket", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createBucket("empty-b");

      const s3 = createS3Client(server.port);
      await s3.send(new PutObjectCommand({ Bucket: "empty-b", Key: "a.txt", Body: "a" }));
      await s3.send(new PutObjectCommand({ Bucket: "empty-b", Key: "b.txt", Body: "b" }));

      server.emptyBucket("empty-b");

      // Bucket still exists
      const buckets = await s3.send(new ListBucketsCommand({}));
      expect(buckets.Buckets).toHaveLength(1);
      expect(buckets.Buckets![0].Name).toBe("empty-b");

      // But objects are gone
      const objects = await s3.send(new ListObjectsV2Command({ Bucket: "empty-b" }));
      expect(objects.Contents ?? []).toHaveLength(0);
    });

    it("is a no-op for non-existent bucket", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      expect(() => server.emptyBucket("no-such-bucket")).not.toThrow();
    });
  });

  describe("reset", () => {
    it("clears messages but keeps queues", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("reset-q");

      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(new ListQueuesCommand({}));
      await sqs.send(new SendMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MessageBody: "hello",
      }));

      server.reset();

      // Queue still exists
      const afterQueues = await sqs.send(new ListQueuesCommand({}));
      expect(afterQueues.QueueUrls).toHaveLength(1);
      expect(afterQueues.QueueUrls![0]).toContain("reset-q");

      // But messages are gone
      const msgs = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: afterQueues.QueueUrls![0],
        WaitTimeSeconds: 0,
      }));
      expect(msgs.Messages ?? []).toHaveLength(0);
    });

    it("clears S3 objects but keeps buckets", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createBucket("reset-bucket");

      const s3 = createS3Client(server.port);
      await s3.send(new PutObjectCommand({
        Bucket: "reset-bucket",
        Key: "test.txt",
        Body: "hello",
      }));

      server.reset();

      // Bucket still exists
      const buckets = await s3.send(new ListBucketsCommand({}));
      expect(buckets.Buckets).toHaveLength(1);
      expect(buckets.Buckets![0].Name).toBe("reset-bucket");

      // But objects are gone
      const objects = await s3.send(new ListObjectsV2Command({ Bucket: "reset-bucket" }));
      expect(objects.Contents ?? []).toHaveLength(0);
    });

    it("keeps topics and subscriptions intact", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("reset-sub-q");
      server.createTopic("reset-topic");
      server.subscribe({ topic: "reset-topic", queue: "reset-sub-q" });

      server.reset();

      const sns = createSnsClient(server.port);
      const topics = await sns.send(new ListTopicsCommand({}));
      expect(topics.Topics).toHaveLength(1);

      const subs = await sns.send(new ListSubscriptionsCommand({}));
      expect(subs.Subscriptions).toHaveLength(1);
    });

    it("clears spy buffer", async () => {
      server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
      server.createQueue("spy-reset-q");

      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(new ListQueuesCommand({}));
      await sqs.send(new SendMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MessageBody: "tracked",
      }));

      // Spy has the message
      expect(server.spy.getAllMessages()).toHaveLength(1);

      server.reset();

      // Spy buffer is cleared
      expect(server.spy.getAllMessages()).toHaveLength(0);
    });

    it("allows sending new messages after reset", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("reset-reuse-q");

      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(new ListQueuesCommand({}));
      await sqs.send(new SendMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MessageBody: "before",
      }));

      server.reset();

      await sqs.send(new SendMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MessageBody: "after",
      }));

      const msgs = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        WaitTimeSeconds: 1,
      }));
      expect(msgs.Messages).toHaveLength(1);
      expect(msgs.Messages![0].Body).toBe("after");
    });
  });
});
