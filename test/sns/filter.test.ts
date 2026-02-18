import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SubscribeCommand,
  PublishCommand,
  SetSubscriptionAttributesCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { createTestServer, type TestServer } from "../helpers/setup.js";

describe("SNS Filter Policies", () => {
  let server: TestServer;
  let sns: ReturnType<typeof createSnsClient>;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await createTestServer();
    sns = createSnsClient(server.port);
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sns.destroy();
    sqs.destroy();
    await server.app.close();
  });

  async function setupTopicAndQueue(
    topicName: string,
    queueName: string,
    filterPolicy: Record<string, unknown>,
    filterPolicyScope?: string,
  ) {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: topicName }),
    );
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: queueName }),
    );
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: attrs.Attributes!.QueueArn!,
      }),
    );

    // Set raw delivery for easier testing
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
        AttributeName: "RawMessageDelivery",
        AttributeValue: "true",
      }),
    );

    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
        AttributeName: "FilterPolicy",
        AttributeValue: JSON.stringify(filterPolicy),
      }),
    );

    if (filterPolicyScope) {
      await sns.send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn: sub.SubscriptionArn!,
          AttributeName: "FilterPolicyScope",
          AttributeValue: filterPolicyScope,
        }),
      );
    }

    return { topicArn: topic.TopicArn!, queueUrl: queue.QueueUrl! };
  }

  it("filters by exact string match on message attributes", async () => {
    const { topicArn, queueUrl } = await setupTopicAndQueue(
      "filter-exact",
      "filter-exact-queue",
      { color: ["blue", "red"] },
    );

    // Should match (color=blue)
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "blue message",
        MessageAttributes: {
          color: { DataType: "String", StringValue: "blue" },
        },
      }),
    );

    // Should NOT match (color=green)
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "green message",
        MessageAttributes: {
          color: { DataType: "String", StringValue: "green" },
        },
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("blue message");
  });

  it("filters by prefix match", async () => {
    const { topicArn, queueUrl } = await setupTopicAndQueue(
      "filter-prefix",
      "filter-prefix-queue",
      { event: [{ prefix: "order_" }] },
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "order created",
        MessageAttributes: {
          event: { DataType: "String", StringValue: "order_created" },
        },
      }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "user signup",
        MessageAttributes: {
          event: { DataType: "String", StringValue: "user_signup" },
        },
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("order created");
  });

  it("filters by numeric range", async () => {
    const { topicArn, queueUrl } = await setupTopicAndQueue(
      "filter-numeric",
      "filter-numeric-queue",
      { price: [{ numeric: [">=", 100, "<", 500] }] },
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "in range",
        MessageAttributes: {
          price: { DataType: "Number", StringValue: "250" },
        },
      }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "out of range",
        MessageAttributes: {
          price: { DataType: "Number", StringValue: "50" },
        },
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("in range");
  });

  it("filters by anything-but", async () => {
    const { topicArn, queueUrl } = await setupTopicAndQueue(
      "filter-anybut",
      "filter-anybut-queue",
      { status: [{ "anything-but": ["cancelled", "failed"] }] },
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "completed",
        MessageAttributes: {
          status: { DataType: "String", StringValue: "completed" },
        },
      }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "cancelled",
        MessageAttributes: {
          status: { DataType: "String", StringValue: "cancelled" },
        },
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("completed");
  });

  it("filters by exists", async () => {
    const { topicArn, queueUrl } = await setupTopicAndQueue(
      "filter-exists",
      "filter-exists-queue",
      { priority: [{ exists: true }] },
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "has priority",
        MessageAttributes: {
          priority: { DataType: "String", StringValue: "high" },
        },
      }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "no priority",
        MessageAttributes: {
          other: { DataType: "String", StringValue: "value" },
        },
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("has priority");
  });

  it("applies AND logic between top-level keys", async () => {
    const { topicArn, queueUrl } = await setupTopicAndQueue(
      "filter-and",
      "filter-and-queue",
      {
        color: ["blue"],
        size: ["large"],
      },
    );

    // Matches both conditions
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "both match",
        MessageAttributes: {
          color: { DataType: "String", StringValue: "blue" },
          size: { DataType: "String", StringValue: "large" },
        },
      }),
    );

    // Only matches color
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "only color",
        MessageAttributes: {
          color: { DataType: "String", StringValue: "blue" },
          size: { DataType: "String", StringValue: "small" },
        },
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("both match");
  });

  it("filters on message body when FilterPolicyScope is MessageBody", async () => {
    const { topicArn, queueUrl } = await setupTopicAndQueue(
      "filter-body",
      "filter-body-queue",
      { event_type: ["order"] },
      "MessageBody",
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify({ event_type: "order", id: 123 }),
      }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify({ event_type: "user", id: 456 }),
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
      }),
    );

    expect(received.Messages).toHaveLength(1);
    const body = JSON.parse(received.Messages![0].Body!);
    expect(body.event_type).toBe("order");
  });
});
