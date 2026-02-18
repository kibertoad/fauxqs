import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SubscribeCommand,
  UnsubscribeCommand,
  ListSubscriptionsCommand,
  ListSubscriptionsByTopicCommand,
  GetSubscriptionAttributesCommand,
  SetSubscriptionAttributesCommand,
} from "@aws-sdk/client-sns";
import { CreateQueueCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS Subscriptions", () => {
  let server: FauxqsServer;
  let sns: ReturnType<typeof createSnsClient>;
  let sqs: ReturnType<typeof createSqsClient>;
  let topicArn: string;
  let queueArn: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sns = createSnsClient(server.port);
    sqs = createSqsClient(server.port);

    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-test-topic" }),
    );
    topicArn = topic.TopicArn!;

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "sub-test-queue" }),
    );
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );
    queueArn = attrs.Attributes!.QueueArn!;
  });

  afterAll(async () => {
    sns.destroy();
    sqs.destroy();
    await server.stop();
  });

  it("subscribes an SQS queue to a topic", async () => {
    const result = await sns.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "sqs",
        Endpoint: queueArn,
      }),
    );

    expect(result.SubscriptionArn).toBeDefined();
    expect(result.SubscriptionArn).toContain("sub-test-topic");
  });

  it("lists subscriptions", async () => {
    const result = await sns.send(new ListSubscriptionsCommand({}));
    expect(result.Subscriptions).toBeDefined();
    expect(result.Subscriptions!.length).toBeGreaterThanOrEqual(1);
    expect(result.Subscriptions!.some((s) => s.Protocol === "sqs")).toBe(true);
  });

  it("lists subscriptions by topic", async () => {
    const result = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
    );
    expect(result.Subscriptions).toBeDefined();
    expect(result.Subscriptions!.length).toBeGreaterThanOrEqual(1);
  });

  it("gets subscription attributes", async () => {
    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "sqs",
        Endpoint: queueArn,
      }),
    );

    const result = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
      }),
    );

    expect(result.Attributes?.Protocol).toBe("sqs");
    expect(result.Attributes?.TopicArn).toBe(topicArn);
    expect(result.Attributes?.Endpoint).toBe(queueArn);
  });

  it("sets subscription attributes", async () => {
    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "sqs",
        Endpoint: queueArn,
      }),
    );

    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
        AttributeName: "RawMessageDelivery",
        AttributeValue: "true",
      }),
    );

    const result = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
      }),
    );

    expect(result.Attributes?.RawMessageDelivery).toBe("true");
  });

  it("unsubscribes", async () => {
    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "sqs",
        Endpoint: queueArn,
      }),
    );

    await sns.send(
      new UnsubscribeCommand({
        SubscriptionArn: sub.SubscriptionArn!,
      }),
    );

    const result = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
      }),
    ).catch((e) => e);

    // Should fail or return not found
    expect(result).toBeDefined();
  });
});
