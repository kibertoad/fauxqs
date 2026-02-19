import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFauxqs, type FauxqsServer } from "../src/app.js";
import { createSqsClient, createSnsClient, createS3Client } from "./helpers/clients.js";
import {
  ListQueuesCommand,
  GetQueueAttributesCommand,
  ListQueueTagsCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  ListTopicsCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  GetSubscriptionAttributesCommand,
  PublishCommand,
} from "@aws-sdk/client-sns";
import {
  ListBucketsCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { loadInitConfig, validateInitConfig } from "../src/initConfig.js";

describe("init config", () => {
  let server: FauxqsServer;
  let tmpDir: string;

  afterEach(async () => {
    if (server) await server.stop();
  });

  function writeTempConfig(config: object): string {
    tmpDir = mkdtempSync(join(tmpdir(), "fauxqs-"));
    const path = join(tmpDir, "init.json");
    writeFileSync(path, JSON.stringify(config));
    return path;
  }

  function cleanupTempConfig(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }

  it("loadInitConfig reads and parses a JSON file", () => {
    const path = writeTempConfig({
      queues: [{ name: "q1" }],
      topics: [{ name: "t1" }],
      buckets: ["b1"],
    });

    const config = loadInitConfig(path);
    expect(config.queues).toEqual([{ name: "q1" }]);
    expect(config.topics).toEqual([{ name: "t1" }]);
    expect(config.buckets).toEqual(["b1"]);

    cleanupTempConfig(path);
  });

  it("loadInitConfig throws for missing file", () => {
    expect(() => loadInitConfig("/nonexistent/path.json")).toThrow();
  });

  it("loadInitConfig throws for invalid JSON", () => {
    const path = writeTempConfig({});
    writeFileSync(path, "not valid json {{{");
    expect(() => loadInitConfig(path)).toThrow();
    cleanupTempConfig(path);
  });

  it("validateInitConfig rejects non-object input", () => {
    expect(() => validateInitConfig("not an object")).toThrow();
    expect(() => validateInitConfig(42)).toThrow();
    expect(() => validateInitConfig(null)).toThrow();
  });

  it("validateInitConfig rejects queues with missing name", () => {
    expect(() => validateInitConfig({ queues: [{}] })).toThrow();
  });

  it("validateInitConfig rejects queues with wrong type for name", () => {
    expect(() => validateInitConfig({ queues: [{ name: 123 }] })).toThrow();
  });

  it("validateInitConfig rejects buckets with wrong element type", () => {
    expect(() => validateInitConfig({ buckets: [123] })).toThrow();
  });

  it("validateInitConfig rejects subscriptions with missing fields", () => {
    expect(() => validateInitConfig({ subscriptions: [{ topic: "t1" }] })).toThrow();
    expect(() => validateInitConfig({ subscriptions: [{ queue: "q1" }] })).toThrow();
  });

  it("validateInitConfig accepts empty config", () => {
    const config = validateInitConfig({});
    expect(config).toEqual({});
  });

  it("validateInitConfig accepts valid full config", () => {
    const config = validateInitConfig({
      queues: [{ name: "q1", attributes: { VisibilityTimeout: "30" }, tags: { env: "dev" } }],
      topics: [{ name: "t1" }],
      subscriptions: [{ topic: "t1", queue: "q1" }],
      buckets: ["b1"],
    });
    expect(config.queues).toHaveLength(1);
    expect(config.topics).toHaveLength(1);
    expect(config.subscriptions).toHaveLength(1);
    expect(config.buckets).toEqual(["b1"]);
  });

  it("loadInitConfig rejects file with invalid structure", () => {
    const path = writeTempConfig({ queues: "not-an-array" });
    expect(() => loadInitConfig(path)).toThrow();
    cleanupTempConfig(path);
  });

  it("applies init config from file path on startup", async () => {
    const configPath = writeTempConfig({
      queues: [{ name: "init-queue" }],
      topics: [{ name: "init-topic" }],
      buckets: ["init-bucket"],
    });

    server = await startFauxqs({ port: 0, logger: false, init: configPath });
    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(1);
    expect(queues.QueueUrls![0]).toContain("init-queue");

    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics).toHaveLength(1);
    expect(topics.Topics![0].TopicArn).toContain("init-topic");

    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets).toHaveLength(1);
    expect(buckets.Buckets![0].Name).toBe("init-bucket");

    cleanupTempConfig(configPath);
  });

  it("applies init config from inline object", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [{ name: "inline-queue" }],
        topics: [{ name: "inline-topic" }],
        buckets: ["inline-bucket"],
      },
    });

    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(1);

    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics).toHaveLength(1);

    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets).toHaveLength(1);
  });

  it("creates subscriptions that wire topics to queues", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [{ name: "sub-queue" }],
        topics: [{ name: "sub-topic" }],
        subscriptions: [{ topic: "sub-topic", queue: "sub-queue" }],
      },
    });

    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);

    // Publish to the topic
    await sns.send(
      new PublishCommand({
        TopicArn: "arn:aws:sns:us-east-1:000000000000:sub-topic",
        Message: "hello from init",
      }),
    );

    // Receive from the queue
    const queues = await sqs.send(new ListQueuesCommand({}));
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );

    expect(result.Messages).toHaveLength(1);
    expect(result.Messages![0].Body).toContain("hello from init");
  });

  it("creates queues with attributes and verifies they are applied", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [
          {
            name: "attr-queue",
            attributes: { VisibilityTimeout: "60", DelaySeconds: "5", ReceiveMessageWaitTimeSeconds: "10" },
          },
        ],
      },
    });

    const sqs = createSqsClient(server.port);
    const queues = await sqs.send(new ListQueuesCommand({}));
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.QueueUrls![0],
        AttributeNames: ["All"],
      }),
    );

    expect(attrs.Attributes!.VisibilityTimeout).toBe("60");
    expect(attrs.Attributes!.DelaySeconds).toBe("5");
    expect(attrs.Attributes!.ReceiveMessageWaitTimeSeconds).toBe("10");
  });

  it("creates queues with tags and verifies they are applied", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [
          {
            name: "tagged-queue",
            tags: { env: "test", team: "platform" },
          },
        ],
      },
    });

    const sqs = createSqsClient(server.port);
    const queues = await sqs.send(new ListQueuesCommand({}));
    const tags = await sqs.send(
      new ListQueueTagsCommand({ QueueUrl: queues.QueueUrls![0] }),
    );

    expect(tags.Tags).toEqual({ env: "test", team: "platform" });
  });

  it("creates FIFO queue via init config", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [
          {
            name: "my-queue.fifo",
            attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
          },
        ],
      },
    });

    const sqs = createSqsClient(server.port);
    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls![0]).toContain("my-queue.fifo");

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.QueueUrls![0],
        AttributeNames: ["All"],
      }),
    );

    expect(attrs.Attributes!.FifoQueue).toBe("true");
    expect(attrs.Attributes!.ContentBasedDeduplication).toBe("true");

    // Verify FIFO queue actually works with a message group
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MessageBody: "fifo-test",
        MessageGroupId: "group1",
      }),
    );

    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(result.Messages).toHaveLength(1);
    expect(result.Messages![0].Body).toBe("fifo-test");
  });

  it("creates topics with attributes and verifies they are applied", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        topics: [
          {
            name: "attr-topic",
            attributes: { DisplayName: "My Topic" },
          },
        ],
      },
    });

    const sns = createSnsClient(server.port);
    const topics = await sns.send(new ListTopicsCommand({}));
    const topicArn = topics.Topics![0].TopicArn!;

    const attrs = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: topicArn }),
    );

    expect(attrs.Attributes!.DisplayName).toBe("My Topic");
    expect(attrs.Attributes!.TopicArn).toBe(topicArn);
  });

  it("creates subscriptions with attributes and verifies them", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [{ name: "sub-attr-queue" }],
        topics: [{ name: "sub-attr-topic" }],
        subscriptions: [
          {
            topic: "sub-attr-topic",
            queue: "sub-attr-queue",
            attributes: { RawMessageDelivery: "true" },
          },
        ],
      },
    });

    const sns = createSnsClient(server.port);
    const topicArn = "arn:aws:sns:us-east-1:000000000000:sub-attr-topic";

    const subs = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
    );
    expect(subs.Subscriptions).toHaveLength(1);
    expect(subs.Subscriptions![0].Protocol).toBe("sqs");
    expect(subs.Subscriptions![0].Endpoint).toContain("sub-attr-queue");

    const subAttrs = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: subs.Subscriptions![0].SubscriptionArn!,
      }),
    );
    expect(subAttrs.Attributes!.RawMessageDelivery).toBe("true");
  });

  it("creates subscription with FilterPolicy via init config", async () => {
    const filterPolicy = JSON.stringify({ color: ["blue", "red"] });
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [{ name: "filter-queue" }],
        topics: [{ name: "filter-topic" }],
        subscriptions: [
          {
            topic: "filter-topic",
            queue: "filter-queue",
            attributes: { FilterPolicy: filterPolicy },
          },
        ],
      },
    });

    const sns = createSnsClient(server.port);
    const topicArn = "arn:aws:sns:us-east-1:000000000000:filter-topic";

    const subs = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
    );
    const subAttrs = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: subs.Subscriptions![0].SubscriptionArn!,
      }),
    );
    expect(subAttrs.Attributes!.FilterPolicy).toBe(filterPolicy);
  });

  it("creates buckets that are usable for object operations", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        buckets: ["usable-bucket"],
      },
    });

    const s3 = createS3Client(server.port);

    // Verify bucket exists via HeadBucket
    await s3.send(new HeadBucketCommand({ Bucket: "usable-bucket" }));

    // Verify we can actually store and retrieve objects
    await s3.send(
      new PutObjectCommand({
        Bucket: "usable-bucket",
        Key: "test-key",
        Body: "hello",
      }),
    );
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "usable-bucket", Key: "test-key" }),
    );
    expect(await obj.Body!.transformToString()).toBe("hello");
  });

  it("creates multiple buckets via init config", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        buckets: ["bucket-a", "bucket-b", "bucket-c"],
      },
    });

    const s3 = createS3Client(server.port);
    const buckets = await s3.send(new ListBucketsCommand({}));
    const names = buckets.Buckets!.map((b) => b.Name).sort();
    expect(names).toEqual(["bucket-a", "bucket-b", "bucket-c"]);
  });

  it("creates full config from JSON file with all fields", async () => {
    const configPath = writeTempConfig({
      queues: [
        {
          name: "file-queue",
          attributes: { VisibilityTimeout: "45", DelaySeconds: "3" },
          tags: { source: "init-file" },
        },
        { name: "file-queue.fifo", attributes: { FifoQueue: "true" } },
      ],
      topics: [
        { name: "file-topic", attributes: { DisplayName: "File Topic" }, tags: { tier: "premium" } },
      ],
      subscriptions: [
        { topic: "file-topic", queue: "file-queue", attributes: { RawMessageDelivery: "true" } },
      ],
      buckets: ["file-bucket"],
    });

    server = await startFauxqs({ port: 0, logger: false, init: configPath });
    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    // Verify queues
    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(2);

    const standardQueueUrl = queues.QueueUrls!.find((u) => u.includes("file-queue") && !u.includes(".fifo"))!;
    const fifoQueueUrl = queues.QueueUrls!.find((u) => u.includes("file-queue.fifo"))!;

    // Standard queue attributes
    const stdAttrs = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: standardQueueUrl, AttributeNames: ["All"] }),
    );
    expect(stdAttrs.Attributes!.VisibilityTimeout).toBe("45");
    expect(stdAttrs.Attributes!.DelaySeconds).toBe("3");

    // Standard queue tags
    const stdTags = await sqs.send(new ListQueueTagsCommand({ QueueUrl: standardQueueUrl }));
    expect(stdTags.Tags).toEqual({ source: "init-file" });

    // FIFO queue attributes
    const fifoAttrs = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: fifoQueueUrl, AttributeNames: ["All"] }),
    );
    expect(fifoAttrs.Attributes!.FifoQueue).toBe("true");

    // Verify topic
    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics).toHaveLength(1);
    const topicArn = topics.Topics![0].TopicArn!;
    const topicAttrs = await sns.send(new GetTopicAttributesCommand({ TopicArn: topicArn }));
    expect(topicAttrs.Attributes!.DisplayName).toBe("File Topic");

    // Verify subscription
    const subs = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
    expect(subs.Subscriptions).toHaveLength(1);
    const subAttrs = await sns.send(
      new GetSubscriptionAttributesCommand({ SubscriptionArn: subs.Subscriptions![0].SubscriptionArn! }),
    );
    expect(subAttrs.Attributes!.RawMessageDelivery).toBe("true");

    // Verify subscription actually delivers raw
    await sns.send(
      new PublishCommand({ TopicArn: topicArn, Message: "raw-test" }),
    );
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: standardQueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("raw-test");

    // Verify bucket
    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets).toHaveLength(1);
    expect(buckets.Buckets![0].Name).toBe("file-bucket");

    cleanupTempConfig(configPath);
  });
});
