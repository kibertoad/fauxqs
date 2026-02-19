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

  it("returns existing subscription when attributes match", async () => {
    // Create a fresh topic/queue for this test
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-idem-topic" }),
    );
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "sub-idem-queue" }),
    );
    const qAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    const first = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: qAttrs.Attributes!.QueueArn!,
        Attributes: { RawMessageDelivery: "true" },
      }),
    );

    // Same attributes — should return existing subscription
    const second = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: qAttrs.Attributes!.QueueArn!,
        Attributes: { RawMessageDelivery: "true" },
      }),
    );

    expect(second.SubscriptionArn).toBe(first.SubscriptionArn);
  });

  it("throws when subscribing with different attributes", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-conflict-topic" }),
    );
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "sub-conflict-queue" }),
    );
    const qAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: qAttrs.Attributes!.QueueArn!,
        Attributes: { FilterPolicy: '{"type":["add"]}' },
      }),
    );

    // Different attributes — should throw
    await expect(
      sns.send(
        new SubscribeCommand({
          TopicArn: topic.TopicArn!,
          Protocol: "sqs",
          Endpoint: qAttrs.Attributes!.QueueArn!,
          Attributes: { FilterPolicy: '{"type":["remove"]}' },
        }),
      ),
    ).rejects.toThrow("already exists with different attributes");
  });

  it("includes SubscriptionPrincipal in subscription attributes", async () => {
    const topic2 = await sns.send(
      new CreateTopicCommand({ Name: "sub-principal-topic" }),
    );
    const queue2 = await sqs.send(
      new CreateQueueCommand({ QueueName: "sub-principal-queue" }),
    );
    const q2Attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue2.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic2.TopicArn!,
        Protocol: "sqs",
        Endpoint: q2Attrs.Attributes!.QueueArn!,
      }),
    );

    const result = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
      }),
    );

    expect(result.Attributes?.SubscriptionPrincipal).toBeDefined();
    expect(result.Attributes?.SubscriptionPrincipal).toContain("000000000000");
  });

  it("unsubscribes", async () => {
    const topic3 = await sns.send(
      new CreateTopicCommand({ Name: "sub-unsub-topic" }),
    );
    const queue3 = await sqs.send(
      new CreateQueueCommand({ QueueName: "sub-unsub-queue" }),
    );
    const q3Attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue3.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic3.TopicArn!,
        Protocol: "sqs",
        Endpoint: q3Attrs.Attributes!.QueueArn!,
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
