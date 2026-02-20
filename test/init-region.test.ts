import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SNSClient,
  CreateTopicCommand,
  ListTopicsCommand,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { startFauxqs, type FauxqsServer } from "../src/app.js";

/**
 * When a defaultRegion is configured and the SDK client uses the same region,
 * init-created resources and SDK-created resources use the same region in their ARNs.
 */
describe("init config region consistency", () => {
  let server: FauxqsServer;
  let sns: SNSClient;
  let sqs: SQSClient;

  const REGION = "eu-central-1";

  beforeAll(async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      defaultRegion: REGION,
      init: {
        topics: [{ name: "init-topic" }],
        queues: [{ name: "init-queue" }],
      },
    });
    sns = new SNSClient({
      region: REGION,
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    sqs = new SQSClient({
      region: REGION,
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  });

  afterAll(async () => {
    sns.destroy();
    sqs.destroy();
    await server.stop();
  });

  it("init-created topic has configured region in ARN", async () => {
    // CreateTopic is idempotent — should return the init-created topic
    const result = await sns.send(new CreateTopicCommand({ Name: "init-topic" }));
    expect(result.TopicArn).toBe(
      `arn:aws:sns:${REGION}:000000000000:init-topic`,
    );
  });

  it("init-created queue has configured region in ARN", async () => {
    const urlResult = await sqs.send(
      new CreateQueueCommand({ QueueName: "init-queue" }),
    );
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: urlResult.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toBe(
      `arn:aws:sqs:${REGION}:000000000000:init-queue`,
    );
  });

  it("can subscribe to init-created topic", async () => {
    const topicArn = `arn:aws:sns:${REGION}:000000000000:init-topic`;
    const queueArn = `arn:aws:sqs:${REGION}:000000000000:init-queue`;

    const result = await sns.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "sqs",
        Endpoint: queueArn,
        ReturnSubscriptionArn: true,
      }),
    );
    expect(result.SubscriptionArn).toContain("init-topic");
  });
});

describe("SDK client region overrides defaultRegion", () => {
  let server: FauxqsServer;
  let sns: SNSClient;
  let sqs: SQSClient;

  const SERVER_REGION = "eu-central-1";
  const CLIENT_REGION = "eu-west-1";

  beforeAll(async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      defaultRegion: SERVER_REGION,
    });
    // Client intentionally uses a DIFFERENT region
    sns = new SNSClient({
      region: CLIENT_REGION,
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    sqs = new SQSClient({
      region: CLIENT_REGION,
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  });

  afterAll(async () => {
    sns.destroy();
    sqs.destroy();
    await server.stop();
  });

  it("CreateTopic uses client region from Authorization header", async () => {
    const result = await sns.send(
      new CreateTopicCommand({ Name: "client-region-topic" }),
    );
    // Client region wins — region from Authorization header overrides defaultRegion
    expect(result.TopicArn).toBe(
      `arn:aws:sns:${CLIENT_REGION}:000000000000:client-region-topic`,
    );
  });

  it("CreateQueue uses client region from Authorization header", async () => {
    const urlResult = await sqs.send(
      new CreateQueueCommand({ QueueName: "client-region-queue" }),
    );
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: urlResult.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toBe(
      `arn:aws:sqs:${CLIENT_REGION}:000000000000:client-region-queue`,
    );
  });

  it("can subscribe when topic and queue created with client region", async () => {
    const topicArn = `arn:aws:sns:${CLIENT_REGION}:000000000000:client-region-topic`;
    const queueArn = `arn:aws:sqs:${CLIENT_REGION}:000000000000:client-region-queue`;

    const result = await sns.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "sqs",
        Endpoint: queueArn,
        ReturnSubscriptionArn: true,
      }),
    );
    expect(result.SubscriptionArn).toContain("client-region-topic");
  });
});

describe("per-resource region in init config", () => {
  let server: FauxqsServer;
  let sqs: SQSClient;
  let sns: SNSClient;

  const DEFAULT_REGION = "us-east-1";
  const CUSTOM_REGION = "ap-southeast-1";

  beforeAll(async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      defaultRegion: DEFAULT_REGION,
      init: {
        queues: [
          { name: "default-queue" },
          { name: "custom-queue", region: CUSTOM_REGION },
        ],
        topics: [
          { name: "default-topic" },
          { name: "custom-topic", region: CUSTOM_REGION },
        ],
        subscriptions: [
          { topic: "custom-topic", queue: "custom-queue", region: CUSTOM_REGION },
        ],
      },
    });
    // Use default region for SDK client
    sqs = new SQSClient({
      region: DEFAULT_REGION,
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    sns = new SNSClient({
      region: DEFAULT_REGION,
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  });

  afterAll(async () => {
    sqs.destroy();
    sns.destroy();
    await server.stop();
  });

  it("queue without region uses default region in ARN", async () => {
    const result = await sqs.send(new CreateQueueCommand({ QueueName: "default-queue" }));
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: result.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toBe(
      `arn:aws:sqs:${DEFAULT_REGION}:000000000000:default-queue`,
    );
  });

  it("queue with explicit region uses that region in ARN", async () => {
    const queues = await sqs.send(new ListQueuesCommand({}));
    const customUrl = queues.QueueUrls!.find((u) => u.includes("custom-queue"));
    expect(customUrl).toBeDefined();

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: customUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toBe(
      `arn:aws:sqs:${CUSTOM_REGION}:000000000000:custom-queue`,
    );
  });

  it("topic without region uses default region in ARN", async () => {
    const topics = await sns.send(new ListTopicsCommand({}));
    const defaultTopic = topics.Topics!.find((t) => t.TopicArn!.includes("default-topic"));
    expect(defaultTopic?.TopicArn).toBe(
      `arn:aws:sns:${DEFAULT_REGION}:000000000000:default-topic`,
    );
  });

  it("topic with explicit region uses that region in ARN", async () => {
    const topics = await sns.send(new ListTopicsCommand({}));
    const customTopic = topics.Topics!.find((t) => t.TopicArn!.includes("custom-topic"));
    expect(customTopic?.TopicArn).toBe(
      `arn:aws:sns:${CUSTOM_REGION}:000000000000:custom-topic`,
    );
  });

  it("subscription with explicit region connects correct topic and queue", async () => {
    const topicArn = `arn:aws:sns:${CUSTOM_REGION}:000000000000:custom-topic`;

    const result = await sns.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "sqs",
        Endpoint: `arn:aws:sqs:${CUSTOM_REGION}:000000000000:custom-queue`,
        ReturnSubscriptionArn: true,
      }),
    );
    // Idempotent — should return existing subscription
    expect(result.SubscriptionArn).toContain("custom-topic");
  });
});

/**
 * Region is part of entity identity. The same queue/topic name in different
 * regions produces independent entities, and requests from one region do not
 * affect entities in another region.
 */
describe("multi-region entity isolation", () => {
  let server: FauxqsServer;
  let sqsA: SQSClient;
  let sqsB: SQSClient;
  let snsA: SNSClient;
  let snsB: SNSClient;

  const REGION_A = "us-east-1";
  const REGION_B = "eu-west-1";

  beforeAll(async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      defaultRegion: REGION_A,
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    const credentials = { accessKeyId: "test", secretAccessKey: "test" };

    sqsA = new SQSClient({ region: REGION_A, endpoint, credentials });
    sqsB = new SQSClient({ region: REGION_B, endpoint, credentials });
    snsA = new SNSClient({ region: REGION_A, endpoint, credentials });
    snsB = new SNSClient({ region: REGION_B, endpoint, credentials });
  });

  afterAll(async () => {
    sqsA.destroy();
    sqsB.destroy();
    snsA.destroy();
    snsB.destroy();
    await server.stop();
  });

  it("same queue name in different regions creates independent queues", async () => {
    const resultA = await sqsA.send(new CreateQueueCommand({ QueueName: "shared-name" }));
    const resultB = await sqsB.send(new CreateQueueCommand({ QueueName: "shared-name" }));

    // URLs should differ (different region in URL)
    expect(resultA.QueueUrl).not.toBe(resultB.QueueUrl);

    const attrsA = await sqsA.send(
      new GetQueueAttributesCommand({
        QueueUrl: resultA.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const attrsB = await sqsB.send(
      new GetQueueAttributesCommand({
        QueueUrl: resultB.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );

    expect(attrsA.Attributes?.QueueArn).toBe(
      `arn:aws:sqs:${REGION_A}:000000000000:shared-name`,
    );
    expect(attrsB.Attributes?.QueueArn).toBe(
      `arn:aws:sqs:${REGION_B}:000000000000:shared-name`,
    );
  });

  it("messages sent to a queue in one region are not visible in the other", async () => {
    // Send a message to region A's queue
    await sqsA.send(
      new SendMessageCommand({
        QueueUrl: (await sqsA.send(new CreateQueueCommand({ QueueName: "msg-isolation" }))).QueueUrl,
        MessageBody: "region-a-message",
      }),
    );

    // Create same-name queue in region B (independent)
    const urlB = (await sqsB.send(new CreateQueueCommand({ QueueName: "msg-isolation" }))).QueueUrl!;

    // Region B's queue should be empty
    const receiveB = await sqsB.send(
      new ReceiveMessageCommand({ QueueUrl: urlB, WaitTimeSeconds: 0 }),
    );
    expect(receiveB.Messages ?? []).toHaveLength(0);
  });

  it("same topic name in different regions creates independent topics", async () => {
    const resultA = await snsA.send(new CreateTopicCommand({ Name: "shared-topic" }));
    const resultB = await snsB.send(new CreateTopicCommand({ Name: "shared-topic" }));

    expect(resultA.TopicArn).toBe(`arn:aws:sns:${REGION_A}:000000000000:shared-topic`);
    expect(resultB.TopicArn).toBe(`arn:aws:sns:${REGION_B}:000000000000:shared-topic`);
    expect(resultA.TopicArn).not.toBe(resultB.TopicArn);
  });

  it("GetQueueUrl returns queue from the client region only", async () => {
    // Ensure both queues exist
    await sqsA.send(new CreateQueueCommand({ QueueName: "region-lookup" }));
    await sqsB.send(new CreateQueueCommand({ QueueName: "region-lookup" }));

    const urlA = await sqsA.send(new GetQueueUrlCommand({ QueueName: "region-lookup" }));
    const urlB = await sqsB.send(new GetQueueUrlCommand({ QueueName: "region-lookup" }));

    expect(urlA.QueueUrl).toContain(REGION_A);
    expect(urlB.QueueUrl).toContain(REGION_B);
    expect(urlA.QueueUrl).not.toBe(urlB.QueueUrl);
  });

  it("requests from one region do not mutate default region for another", async () => {
    // Create queue with region B client
    await sqsB.send(new CreateQueueCommand({ QueueName: "no-mutation-test" }));

    // Create queue with region A client — should still use region A, not B
    const resultA = await sqsA.send(new CreateQueueCommand({ QueueName: "no-mutation-test" }));
    const attrsA = await sqsA.send(
      new GetQueueAttributesCommand({
        QueueUrl: resultA.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    expect(attrsA.Attributes?.QueueArn).toBe(
      `arn:aws:sqs:${REGION_A}:000000000000:no-mutation-test`,
    );

    // Create topic with region B client
    await snsB.send(new CreateTopicCommand({ Name: "no-mutation-test" }));

    // Create topic with region A client — should still use region A
    const topicA = await snsA.send(new CreateTopicCommand({ Name: "no-mutation-test" }));
    expect(topicA.TopicArn).toBe(
      `arn:aws:sns:${REGION_A}:000000000000:no-mutation-test`,
    );
  });
});
