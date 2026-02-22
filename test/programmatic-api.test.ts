import { describe, it, expect, afterEach } from "vitest";
import { startFauxqs, type FauxqsServer } from "../src/app.js";
import { createSqsClient, createSnsClient, createS3Client } from "./helpers/clients.js";
import {
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
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

  describe("sendMessage", () => {
    it("enqueues message receivable via SDK", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const { queueUrl } = server.createQueue("send-q");

      const result = server.sendMessage("send-q", "hello programmatic");
      expect(result.messageId).toBeDefined();
      expect(result.md5OfBody).toBeDefined();

      const sqs = createSqsClient(server.port);
      const msgs = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }),
      );
      expect(msgs.Messages).toHaveLength(1);
      expect(msgs.Messages![0].Body).toBe("hello programmatic");
      expect(msgs.Messages![0].MessageId).toBe(result.messageId);
    });

    it("sends with messageAttributes", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const { queueUrl } = server.createQueue("send-attr-q");

      server.sendMessage("send-attr-q", "with attrs", {
        messageAttributes: {
          color: { DataType: "String", StringValue: "blue" },
        },
      });

      const sqs = createSqsClient(server.port);
      const msgs = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ["All"],
        }),
      );
      expect(msgs.Messages).toHaveLength(1);
      expect(msgs.Messages![0].MessageAttributes?.color?.StringValue).toBe("blue");
    });

    it("sends with delaySeconds", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const { queueUrl } = server.createQueue("send-delay-q");

      server.sendMessage("send-delay-q", "delayed", { delaySeconds: 1 });

      // Not immediately visible
      const sqs = createSqsClient(server.port);
      const immediate = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 0 }),
      );
      expect(immediate.Messages ?? []).toHaveLength(0);

      // Visible after delay
      const delayed = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 2 }),
      );
      expect(delayed.Messages).toHaveLength(1);
      expect(delayed.Messages![0].Body).toBe("delayed");
    });

    it("sends to FIFO queue and returns sequenceNumber", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const { queueUrl } = server.createQueue("send-fifo-q.fifo", {
        attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      });

      const r1 = server.sendMessage("send-fifo-q.fifo", "msg1", { messageGroupId: "g1" });
      const r2 = server.sendMessage("send-fifo-q.fifo", "msg2", { messageGroupId: "g1" });

      expect(r1.sequenceNumber).toBeDefined();
      expect(r2.sequenceNumber).toBeDefined();
      expect(Number(r2.sequenceNumber)).toBeGreaterThan(Number(r1.sequenceNumber));

      const sqs = createSqsClient(server.port);
      const msgs = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      expect(msgs.Messages).toHaveLength(1);
      expect(msgs.Messages![0].Body).toBe("msg1");

      // Delete first to unlock group, then receive second
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msgs.Messages![0].ReceiptHandle }));
      const msgs2 = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      expect(msgs2.Messages).toHaveLength(1);
      expect(msgs2.Messages![0].Body).toBe("msg2");
    });

    it("throws for non-existent queue", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      expect(() => server.sendMessage("no-such-queue", "hello")).toThrow("not found");
    });

    it("is visible in inspectQueue", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("inspect-send-q");

      server.sendMessage("inspect-send-q", "inspectable");

      const state = server.inspectQueue("inspect-send-q");
      expect(state).toBeDefined();
      expect(state!.messages.ready).toHaveLength(1);
      expect(state!.messages.ready[0].body).toBe("inspectable");
    });

    it("applies queue-level DelaySeconds default", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const { queueUrl } = server.createQueue("queue-delay-q", {
        attributes: { DelaySeconds: "1" },
      });

      server.sendMessage("queue-delay-q", "default-delayed");

      // Not immediately visible (queue default delay = 1s)
      const sqs = createSqsClient(server.port);
      const immediate = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 0 }),
      );
      expect(immediate.Messages ?? []).toHaveLength(0);

      // Visible after delay
      const delayed = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 2 }),
      );
      expect(delayed.Messages).toHaveLength(1);
      expect(delayed.Messages![0].Body).toBe("default-delayed");
    });

    it("rejects invalid message body characters", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("invalid-char-q");

      expect(() => server.sendMessage("invalid-char-q", "bad\x00char")).toThrow(
        "Invalid characters",
      );
    });

    it("rejects messages exceeding MaximumMessageSize", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("small-q", {
        attributes: { MaximumMessageSize: "1024" },
      });

      const bigBody = "x".repeat(2000);
      expect(() => server.sendMessage("small-q", bigBody)).toThrow(
        "shorter than 1024 bytes",
      );
    });

    it("returns md5OfMessageAttributes when attributes are provided", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("md5-attr-q");

      const result = server.sendMessage("md5-attr-q", "body", {
        messageAttributes: {
          color: { DataType: "String", StringValue: "blue" },
        },
      });
      expect(result.md5OfMessageAttributes).toBeDefined();
      expect(result.md5OfMessageAttributes).toMatch(/^[a-f0-9]{32}$/);

      // Without attributes, md5OfMessageAttributes should be absent
      const result2 = server.sendMessage("md5-attr-q", "body2");
      expect(result2.md5OfMessageAttributes).toBeUndefined();
    });

    it("rejects per-message DelaySeconds on FIFO queues", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      server.createQueue("fifo-nodelay.fifo", {
        attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      });

      expect(() =>
        server.sendMessage("fifo-nodelay.fifo", "msg", {
          messageGroupId: "g1",
          delaySeconds: 5,
        }),
      ).toThrow("not valid for this queue type");
    });
  });

  describe("publish", () => {
    it("fans out to subscribed queue", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const { queueUrl } = server.createQueue("pub-q");
      server.createTopic("pub-t");
      server.subscribe({ topic: "pub-t", queue: "pub-q" });

      const result = server.publish("pub-t", "published message");
      expect(result.messageId).toBeDefined();

      const sqs = createSqsClient(server.port);
      const msgs = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }),
      );
      expect(msgs.Messages).toHaveLength(1);
      expect(msgs.Messages![0].Body).toContain("published message");
    });

    it("applies filter policy", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const { queueUrl } = server.createQueue("filter-q");
      server.createTopic("filter-t");
      server.subscribe({
        topic: "filter-t",
        queue: "filter-q",
        attributes: {
          FilterPolicy: JSON.stringify({ color: ["blue"] }),
        },
      });

      // Non-matching message — should be filtered
      server.publish("filter-t", "red msg", {
        messageAttributes: {
          color: { DataType: "String", StringValue: "red" },
        },
      });

      // Matching message
      server.publish("filter-t", "blue msg", {
        messageAttributes: {
          color: { DataType: "String", StringValue: "blue" },
        },
      });

      const sqs = createSqsClient(server.port);
      const msgs = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
      );
      expect(msgs.Messages).toHaveLength(1);
      // Wrapped in SNS envelope
      const envelope = JSON.parse(msgs.Messages![0].Body!);
      expect(envelope.Message).toBe("blue msg");
    });

    it("delivers raw when RawMessageDelivery is true", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const { queueUrl } = server.createQueue("raw-q");
      server.createTopic("raw-t");
      server.subscribe({
        topic: "raw-t",
        queue: "raw-q",
        attributes: { RawMessageDelivery: "true" },
      });

      server.publish("raw-t", "raw body");

      const sqs = createSqsClient(server.port);
      const msgs = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }),
      );
      expect(msgs.Messages).toHaveLength(1);
      expect(msgs.Messages![0].Body).toBe("raw body");
    });

    it("preserves message body containing special strings in envelope", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      const { queueUrl } = server.createQueue("special-q");
      server.createTopic("special-t");
      server.subscribe({ topic: "special-t", queue: "special-q" });

      const tricky = "message with __UNSUB_ARN_PLACEHOLDER__ in it";
      server.publish("special-t", tricky);

      const sqs = createSqsClient(server.port);
      const msgs = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }),
      );
      expect(msgs.Messages).toHaveLength(1);
      const envelope = JSON.parse(msgs.Messages![0].Body!);
      expect(envelope.Message).toBe(tricky);
      // UnsubscribeURL should be a proper URL, not corrupted
      expect(envelope.UnsubscribeURL).toContain("https://sns.us-east-1.amazonaws.com/");
    });

    it("throws for non-existent topic", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      expect(() => server.publish("no-such-topic", "hello")).toThrow("not found");
    });

    it("emits spy events", async () => {
      server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
      server.createQueue("spy-pub-q");
      server.createTopic("spy-pub-t");
      server.subscribe({ topic: "spy-pub-t", queue: "spy-pub-q" });

      server.publish("spy-pub-t", "spy message");

      const messages = server.spy.getAllMessages();
      // Should have SNS published event + SQS published event (fan-out)
      const snsEvents = messages.filter((m) => m.service === "sns");
      const sqsEvents = messages.filter((m) => m.service === "sqs");
      expect(snsEvents).toHaveLength(1);
      expect(snsEvents[0].status).toBe("published");
      expect(sqsEvents).toHaveLength(1);
      expect(sqsEvents[0].status).toBe("published");
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
