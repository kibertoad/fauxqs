import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SubscribeCommand,
  PublishCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS FIFO Topics", () => {
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

  it("creates a FIFO topic with .fifo suffix", async () => {
    const result = await sns.send(
      new CreateTopicCommand({ Name: "my-topic.fifo" }),
    );
    expect(result.TopicArn).toContain("my-topic.fifo");
  });

  it("publishes to FIFO SQS queue via FIFO topic", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({
        Name: `pub-fifo-${Date.now()}.fifo`,
        Attributes: { FifoTopic: "true", ContentBasedDeduplication: "true" },
      }),
    );

    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `sub-fifo-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

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
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "fifo-sns-message",
        MessageGroupId: "group1",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["All"],
      }),
    );

    expect(received.Messages).toHaveLength(1);
    // Message arrives with FIFO attributes
    expect(received.Messages![0].Attributes?.MessageGroupId).toBe("group1");
    expect(received.Messages![0].Attributes?.SequenceNumber).toBeDefined();
  });

  it("deduplicates through SNS→SQS fan-out", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({
        Name: `dedup-fanout-${Date.now()}.fifo`,
        Attributes: { FifoTopic: "true" },
      }),
    );

    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `dedup-fanout-q-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

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

    // Publish same message twice with same dedup ID
    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "dedup-msg",
        MessageGroupId: "group1",
        MessageDeduplicationId: "same-dedup",
      }),
    );
    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "dedup-msg",
        MessageGroupId: "group1",
        MessageDeduplicationId: "same-dedup",
      }),
    );

    // Only one message should arrive
    const first = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MaxNumberOfMessages: 10,
      }),
    );
    expect(first.Messages).toHaveLength(1);
  });

  it("errors when MessageGroupId is missing on FIFO topic publish", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({
        Name: `no-group-topic-${Date.now()}.fifo`,
        Attributes: { FifoTopic: "true", ContentBasedDeduplication: "true" },
      }),
    );

    await expect(
      sns.send(
        new PublishCommand({
          TopicArn: topic.TopicArn!,
          Message: "test",
        }),
      ),
    ).rejects.toThrow("MessageGroupId");
  });
});
