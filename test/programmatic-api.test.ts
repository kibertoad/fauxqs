import { describe, it, expect, afterEach } from "vitest";
import { startFauxqs, type FauxqsServer } from "../src/app.js";
import { createSqsClient, createSnsClient, createS3Client } from "./helpers/clients.js";
import {
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { ListTopicsCommand, ListSubscriptionsCommand, PublishCommand } from "@aws-sdk/client-sns";
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

  it("createQueue makes queue visible via SDK", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("prog-queue");

    const sqs = createSqsClient(server.port);
    const result = await sqs.send(new ListQueuesCommand({}));
    expect(result.QueueUrls).toHaveLength(1);
    expect(result.QueueUrls![0]).toContain("prog-queue");
  });

  it("createQueue with attributes and tags", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("prog-queue-attrs", {
      attributes: { VisibilityTimeout: "120" },
      tags: { team: "platform" },
    });

    const sqs = createSqsClient(server.port);
    const result = await sqs.send(new ListQueuesCommand({}));
    expect(result.QueueUrls).toHaveLength(1);
  });

  it("createTopic makes topic visible via SDK", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createTopic("prog-topic");

    const sns = createSnsClient(server.port);
    const result = await sns.send(new ListTopicsCommand({}));
    expect(result.Topics).toHaveLength(1);
    expect(result.Topics![0].TopicArn).toContain("prog-topic");
  });

  it("createTopic with attributes and tags", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createTopic("prog-topic-attrs", {
      attributes: { DisplayName: "My Topic" },
      tags: { team: "platform" },
    });

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

  it("createBucket makes bucket visible via SDK", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createBucket("prog-bucket");

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
