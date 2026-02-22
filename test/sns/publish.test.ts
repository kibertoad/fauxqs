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
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS Publish", () => {
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

  it("publishes to an SQS subscriber (wrapped delivery)", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "pub-wrapped" }),
    );
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "pub-wrapped-queue" }),
    );
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

    const published = await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "hello from SNS",
        Subject: "Test Subject",
      }),
    );
    expect(published.MessageId).toBeDefined();

    // Receive from SQS
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }),
    );

    expect(received.Messages).toHaveLength(1);

    // Parse the SNS envelope
    const envelope = JSON.parse(received.Messages![0].Body!);
    expect(envelope.Type).toBe("Notification");
    expect(envelope.Message).toBe("hello from SNS");
    expect(envelope.Subject).toBe("Test Subject");
    expect(envelope.TopicArn).toBe(topic.TopicArn);
    expect(envelope.MessageId).toBe(published.MessageId);
  });

  it("publishes with raw message delivery", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "pub-raw" }),
    );
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "pub-raw-queue" }),
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

    // Enable raw delivery
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
        AttributeName: "RawMessageDelivery",
        AttributeValue: "true",
      }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "raw message body",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }),
    );

    expect(received.Messages).toHaveLength(1);
    // Raw delivery: body is the message directly, not an envelope
    expect(received.Messages![0].Body).toBe("raw message body");
  });

  it("rejects message exceeding 256 KB size limit", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "pub-size-limit" }),
    );

    const largeMessage = "x".repeat(262_145); // 1 byte over 256KB limit
    await expect(
      sns.send(
        new PublishCommand({
          TopicArn: topic.TopicArn!,
          Message: largeMessage,
        }),
      ),
    ).rejects.toThrow("Message too long");
  });

  it("fans out to multiple subscribers", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "pub-fanout" }),
    );

    const queue1 = await sqs.send(
      new CreateQueueCommand({ QueueName: "fanout-queue-1" }),
    );
    const queue2 = await sqs.send(
      new CreateQueueCommand({ QueueName: "fanout-queue-2" }),
    );

    const attrs1 = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue1.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );
    const attrs2 = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue2.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: attrs1.Attributes!.QueueArn!,
      }),
    );
    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: attrs2.Attributes!.QueueArn!,
      }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "broadcast",
      }),
    );

    const received1 = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue1.QueueUrl! }),
    );
    const received2 = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue2.QueueUrl! }),
    );

    expect(received1.Messages).toHaveLength(1);
    expect(received2.Messages).toHaveLength(1);

    const body1 = JSON.parse(received1.Messages![0].Body!);
    const body2 = JSON.parse(received2.Messages![0].Body!);
    expect(body1.Message).toBe("broadcast");
    expect(body2.Message).toBe("broadcast");
  });

  it("throws NotFound when publishing to non-existent topic ARN", async () => {
    await expect(
      sns.send(
        new PublishCommand({
          TopicArn: "arn:aws:sns:us-east-1:000000000000:nonexistent-topic",
          Message: "test",
        }),
      ),
    ).rejects.toThrow(/not exist|NotFound/);
  });

  it("throws NotFound when publishing to a cross-region topic ARN", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "region-test-topic" }),
    );
    const wrongRegionArn = topic.TopicArn!.replace("us-east-1", "eu-west-1");
    await expect(
      sns.send(
        new PublishCommand({ TopicArn: wrongRegionArn, Message: "test" }),
      ),
    ).rejects.toThrow(/not exist|NotFound/);
  });

  it("rejects message when body + attributes exceed 256KB", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "size-limit-attrs-topic" }),
    );
    const body = "x".repeat(200_000);
    const largeAttrValue = "y".repeat(62_200);
    await expect(
      sns.send(
        new PublishCommand({
          TopicArn: topic.TopicArn!,
          Message: body,
          MessageAttributes: {
            LargeAttr: { DataType: "String", StringValue: largeAttrValue },
          },
        }),
      ),
    ).rejects.toThrow(/too long|Message must be shorter/i);
  });

  it("accepts message when body + attributes are within 256KB", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "size-ok-attrs-topic" }),
    );
    const body = "x".repeat(200_000);
    const attrValue = "y".repeat(50_000);
    const result = await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: body,
        MessageAttributes: {
          Attr: { DataType: "String", StringValue: attrValue },
        },
      }),
    );
    expect(result.MessageId).toBeDefined();
  });

  it("does not retroactively deliver messages published before subscription", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "pre-sub-topic" }),
    );
    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "before-subscribe",
      }),
    );
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "pre-sub-queue" }),
    );
    const queueArn = (
      await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queue.QueueUrl!,
          AttributeNames: ["QueueArn"],
        }),
      )
    ).Attributes!.QueueArn;
    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: queueArn!,
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }),
    );
    expect(received.Messages).toBeUndefined();
  });
});
