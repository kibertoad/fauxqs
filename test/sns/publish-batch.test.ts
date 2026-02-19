import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SubscribeCommand,
  PublishBatchCommand,
  SetSubscriptionAttributesCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS PublishBatch", () => {
  let server: FauxqsServer;
  let sns: ReturnType<typeof createSnsClient>;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sns = createSnsClient(server.port);
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sns.destroy();
    sqs.destroy();
    await server.stop();
  });

  it("delivers batch messages to subscribers", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "batch-topic" }));
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "batch-queue" }));
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: attrs.Attributes!.QueueArn!,
      }),
    );

    const result = await sns.send(
      new PublishBatchCommand({
        TopicArn: topic.TopicArn!,
        PublishBatchRequestEntries: [
          { Id: "1", Message: "batch-msg-1" },
          { Id: "2", Message: "batch-msg-2" },
        ],
      }),
    );

    expect(result.Successful).toHaveLength(2);

    // Receive both messages
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MaxNumberOfMessages: 10,
      }),
    );

    expect(received.Messages).toHaveLength(2);
    const bodies = received.Messages!.map((m) => {
      const envelope = JSON.parse(m.Body!);
      return envelope.Message;
    }).sort();
    expect(bodies).toEqual(["batch-msg-1", "batch-msg-2"]);
  });

  it("applies filter policies to batch messages", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "batch-filter-topic" }));
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "batch-filter-queue" }));
    const queueAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: queueAttrs.Attributes!.QueueArn!,
      }),
    );

    // Set filter policy to only accept messages with color=red
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
        AttributeName: "FilterPolicy",
        AttributeValue: JSON.stringify({ color: ["red"] }),
      }),
    );

    await sns.send(
      new PublishBatchCommand({
        TopicArn: topic.TopicArn!,
        PublishBatchRequestEntries: [
          {
            Id: "match",
            Message: "should-arrive",
            MessageAttributes: {
              color: { DataType: "String", StringValue: "red" },
            },
          },
          {
            Id: "no-match",
            Message: "should-not-arrive",
            MessageAttributes: {
              color: { DataType: "String", StringValue: "blue" },
            },
          },
        ],
      }),
    );

    // Only the matching message should be delivered
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );

    expect(received.Messages).toHaveLength(1);
    const envelope = JSON.parse(received.Messages![0].Body!);
    expect(envelope.Message).toBe("should-arrive");
  });

  it("forwards message attributes in raw delivery", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "batch-raw-attrs" }));
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "batch-raw-attrs-queue" }));
    const queueAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: queueAttrs.Attributes!.QueueArn!,
      }),
    );

    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
        AttributeName: "RawMessageDelivery",
        AttributeValue: "true",
      }),
    );

    await sns.send(
      new PublishBatchCommand({
        TopicArn: topic.TopicArn!,
        PublishBatchRequestEntries: [
          {
            Id: "1",
            Message: "raw-batch-msg",
            MessageAttributes: {
              MyAttr: { DataType: "String", StringValue: "hello" },
            },
          },
        ],
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageAttributeNames: ["All"],
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("raw-batch-msg");
    expect(received.Messages![0].MessageAttributes?.MyAttr?.StringValue).toBe("hello");
  });

  it("includes message attributes in wrapped envelope", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "batch-envelope-attrs" }));
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "batch-envelope-queue" }));
    const queueAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: queueAttrs.Attributes!.QueueArn!,
      }),
    );

    await sns.send(
      new PublishBatchCommand({
        TopicArn: topic.TopicArn!,
        PublishBatchRequestEntries: [
          {
            Id: "1",
            Message: "envelope-msg",
            MessageAttributes: {
              EventType: { DataType: "String", StringValue: "order.created" },
            },
          },
        ],
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }),
    );

    expect(received.Messages).toHaveLength(1);
    const envelope = JSON.parse(received.Messages![0].Body!);
    expect(envelope.Message).toBe("envelope-msg");
    expect(envelope.MessageAttributes).toBeDefined();
    expect(envelope.MessageAttributes.EventType).toEqual({
      Type: "String",
      Value: "order.created",
    });
  });
});
