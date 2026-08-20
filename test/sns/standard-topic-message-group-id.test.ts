import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  CreateTopicCommand,
  SubscribeCommand,
  PublishCommand,
  PublishBatchCommand,
} from "@aws-sdk/client-sns";
import { startFauxqs, type FauxqsServer } from "../../src/app.js";
import { createSqsClient, createSnsClient } from "../helpers/clients.js";

describe("SNS MessageGroupId on standard topics (fair queues)", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let sns: ReturnType<typeof createSnsClient>;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
    sqs = createSqsClient(server.port);
    sns = createSnsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    sns.destroy();
    await server.stop();
  });

  async function createSubscribedQueue(
    queueName: string,
    topicName: string,
    rawDelivery: boolean,
  ): Promise<{ queueUrl: string; topicArn: string }> {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );
    const topic = await sns.send(new CreateTopicCommand({ Name: topicName }));
    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: attrs.Attributes!.QueueArn!,
        ...(rawDelivery ? { Attributes: { RawMessageDelivery: "true" } } : {}),
      }),
    );
    return { queueUrl: queue.QueueUrl!, topicArn: topic.TopicArn! };
  }

  it("forwards MessageGroupId from Publish to a subscribed standard queue (raw delivery)", async () => {
    const { queueUrl, topicArn } = await createSubscribedQueue(
      "fair-sns-raw-q",
      "fair-sns-raw-topic",
      true,
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "fair event",
        MessageGroupId: "tenant-sns",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("fair event");
    expect(received.Messages![0].Attributes?.MessageGroupId).toBe("tenant-sns");
  });

  it("forwards MessageGroupId with enveloped (non-raw) delivery too", async () => {
    const { queueUrl, topicArn } = await createSubscribedQueue(
      "fair-sns-envelope-q",
      "fair-sns-envelope-topic",
      false,
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "enveloped event",
        MessageGroupId: "tenant-envelope",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Attributes?.MessageGroupId).toBe("tenant-envelope");
    const envelope = JSON.parse(received.Messages![0].Body!);
    expect(envelope.Message).toBe("enveloped event");
  });

  it("publishes without MessageGroupId exactly as before", async () => {
    const { queueUrl, topicArn } = await createSubscribedQueue(
      "fair-sns-plain-q",
      "fair-sns-plain-topic",
      true,
    );

    await sns.send(new PublishCommand({ TopicArn: topicArn, Message: "plain event" }));

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );

    expect(received.Messages![0].Attributes?.MessageGroupId).toBeUndefined();
  });

  it("forwards per-entry MessageGroupId from PublishBatch", async () => {
    const { queueUrl, topicArn } = await createSubscribedQueue(
      "fair-sns-batch-q",
      "fair-sns-batch-topic",
      true,
    );

    const result = await sns.send(
      new PublishBatchCommand({
        TopicArn: topicArn,
        PublishBatchRequestEntries: [
          { Id: "a", Message: "batch a", MessageGroupId: "tenant-a" },
          { Id: "b", Message: "batch b" },
        ],
      }),
    );
    expect(result.Successful).toHaveLength(2);

    const groupsByBody = new Map<string, string | undefined>();
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    for (const msg of received.Messages ?? []) {
      groupsByBody.set(msg.Body!, msg.Attributes?.MessageGroupId);
    }

    expect(groupsByBody.get("batch a")).toBe("tenant-a");
    expect(groupsByBody.get("batch b")).toBeUndefined();
  });

  it("rejects a malformed MessageGroupId on Publish to a standard topic", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "fair-sns-invalid-topic" }));

    await expect(
      sns.send(
        new PublishCommand({
          TopicArn: topic.TopicArn!,
          Message: "event",
          MessageGroupId: "g".repeat(129),
        }),
      ),
    ).rejects.toThrow("MessageGroupId can only include alphanumeric and punctuation characters");
  });

  it("fails only the offending entry in PublishBatch", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "fair-sns-batch-partial" }));

    const result = await sns.send(
      new PublishBatchCommand({
        TopicArn: topic.TopicArn!,
        PublishBatchRequestEntries: [
          { Id: "ok", Message: "fine", MessageGroupId: "tenant-ok" },
          { Id: "bad", Message: "broken", MessageGroupId: "not valid" },
        ],
      }),
    );

    expect(result.Successful).toHaveLength(1);
    expect(result.Successful![0].Id).toBe("ok");
    expect(result.Failed).toHaveLength(1);
    expect(result.Failed![0].Id).toBe("bad");
    expect(result.Failed![0].Code).toBe("InvalidParameter");
  });

  it("exposes messageGroupId in SNS spy events", async () => {
    const { topicArn } = await createSubscribedQueue(
      "fair-sns-spy-q",
      "fair-sns-spy-topic",
      true,
    );

    const published = await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: "spied event",
        MessageGroupId: "tenant-sns-spy",
      }),
    );

    const spied = server.spy.checkForMessage(
      (m) => "messageId" in m && m.messageId === published.MessageId,
      "published",
    );
    expect(spied).toBeDefined();
    expect((spied as { messageGroupId?: string }).messageGroupId).toBe("tenant-sns-spy");
  });
});
