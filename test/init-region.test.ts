import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { startFauxqs, type FauxqsServer } from "../src/app.js";

/**
 * When a defaultRegion is configured, init-created resources and
 * SDK-created resources must use the same region in their ARNs.
 * The store region is locked by applyInitConfig so the first
 * request's Authorization header cannot override it.
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

describe("init config region locks store against SDK override", () => {
  let server: FauxqsServer;
  let sns: SNSClient;

  const SERVER_REGION = "eu-central-1";
  const CLIENT_REGION = "ap-southeast-1";

  beforeAll(async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      defaultRegion: SERVER_REGION,
      init: {
        topics: [{ name: "locked-topic" }],
      },
    });
    // Client intentionally uses a DIFFERENT region
    sns = new SNSClient({
      region: CLIENT_REGION,
      endpoint: `http://127.0.0.1:${server.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  });

  afterAll(async () => {
    sns.destroy();
    await server.stop();
  });

  it("CreateTopic uses server region, not client region", async () => {
    const result = await sns.send(
      new CreateTopicCommand({ Name: "sdk-created-topic" }),
    );
    // Server region wins — store is locked
    expect(result.TopicArn).toBe(
      `arn:aws:sns:${SERVER_REGION}:000000000000:sdk-created-topic`,
    );
  });

  it("init-created topic is found via CreateTopic idempotency", async () => {
    // Even though client uses ap-southeast-1, the server returns eu-central-1 ARN
    const result = await sns.send(
      new CreateTopicCommand({ Name: "locked-topic" }),
    );
    expect(result.TopicArn).toBe(
      `arn:aws:sns:${SERVER_REGION}:000000000000:locked-topic`,
    );
  });
});
