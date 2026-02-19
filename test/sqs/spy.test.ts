import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SetQueueAttributesCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import {
  CreateTopicCommand,
  SubscribeCommand,
  PublishCommand,
  SetSubscriptionAttributesCommand,
} from "@aws-sdk/client-sns";
import { createSqsClient, createSnsClient } from "../helpers/clients.js";
import { startFauxqs, type FauxqsServer } from "../../src/app.js";

function startSpyServer(spyOptions?: boolean | { bufferSize?: number }) {
  return startFauxqs({ port: 0, logger: false, messageSpies: spyOptions ?? true });
}

describe("MessageSpy", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startSpyServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("tracks published messages from SendMessage", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-send" }),
    );

    const result = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "spy test",
      }),
    );

    const msg = server.spy.checkForMessage(
      (m) => m.messageId === result.MessageId,
      "published",
    );
    expect(msg).toBeDefined();
    expect(msg!.body).toBe("spy test");
    expect(msg!.queueName).toBe("spy-send");
    expect(msg!.status).toBe("published");
  });

  it("tracks published messages from SendMessageBatch", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-batch" }),
    );

    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queue.QueueUrl!,
        Entries: [
          { Id: "a", MessageBody: "batch-a" },
          { Id: "b", MessageBody: "batch-b" },
        ],
      }),
    );

    for (const entry of result.Successful!) {
      const msg = server.spy.checkForMessage(
        (m) => m.messageId === entry.MessageId,
        "published",
      );
      expect(msg).toBeDefined();
    }
  });

  it("tracks published messages from SNS fan-out", async () => {
    const sns = createSnsClient(server.port);
    try {
      const topic = await sns.send(
        new CreateTopicCommand({ Name: "spy-topic" }),
      );
      const queue = await sqs.send(
        new CreateQueueCommand({ QueueName: "spy-fanout-queue" }),
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

      // Enable raw delivery so body matches
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
          Message: "via sns",
        }),
      );

      const msg = server.spy.checkForMessage(
        (m) => m.body === "via sns" && m.queueName === "spy-fanout-queue",
        "published",
      );
      expect(msg).toBeDefined();
    } finally {
      sns.destroy();
    }
  });

  it("tracks consumed messages from DeleteMessage", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-consume" }),
    );

    const sendResult = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "consume me",
      }),
    );

    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }),
    );

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queue.QueueUrl!,
        ReceiptHandle: recv.Messages![0].ReceiptHandle!,
      }),
    );

    const msg = server.spy.checkForMessage(
      (m) => m.messageId === sendResult.MessageId,
      "consumed",
    );
    expect(msg).toBeDefined();
    expect(msg!.body).toBe("consume me");
    expect(msg!.queueName).toBe("spy-consume");
  });

  it("tracks DLQ messages", async () => {
    const dlq = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-dlq" }),
    );
    const dlqAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    const source = await sqs.send(
      new CreateQueueCommand({
        QueueName: "spy-dlq-source",
        Attributes: { VisibilityTimeout: "1" },
      }),
    );

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: source.QueueUrl!,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqAttrs.Attributes!.QueueArn,
            maxReceiveCount: 1,
          }),
        },
      }),
    );

    const sendResult = await sqs.send(
      new SendMessageCommand({
        QueueUrl: source.QueueUrl!,
        MessageBody: "will die",
      }),
    );

    // First receive
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    await new Promise((r) => setTimeout(r, 1200));

    // Second receive triggers DLQ (receiveCount 2 > maxReceiveCount 1)
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );

    // Should have dlq event on source queue
    const dlqMsg = server.spy.checkForMessage(
      (m) => m.messageId === sendResult.MessageId,
      "dlq",
    );
    expect(dlqMsg).toBeDefined();
    expect(dlqMsg!.queueName).toBe("spy-dlq-source");

    // Should also have published event on the DLQ queue
    const publishedOnDlq = server.spy.checkForMessage(
      (m) =>
        m.messageId === sendResult.MessageId &&
        m.queueName === "spy-dlq" &&
        m.status === "published",
    );
    expect(publishedOnDlq).toBeDefined();
  });

  it("resolves retroactively when message already in buffer", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-retro" }),
    );

    const result = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "already here",
      }),
    );

    // Message already in buffer — waitForMessage should resolve immediately
    const msg = await server.spy.waitForMessage(
      (m) => m.messageId === result.MessageId,
      "published",
    );
    expect(msg.body).toBe("already here");
  });

  it("resolves in the future when message has not arrived yet", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-future" }),
    );

    // Start waiting before the message is sent
    const promise = server.spy.waitForMessage(
      (m) => m.queueName === "spy-future" && m.body === "coming soon",
      "published",
    );

    // Small delay to ensure waiter is registered
    await new Promise((r) => setTimeout(r, 50));

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "coming soon",
      }),
    );

    const msg = await promise;
    expect(msg.body).toBe("coming soon");
    expect(msg.queueName).toBe("spy-future");
  });

  it("waitForMessageWithId matches by SQS messageId", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-byid" }),
    );

    const result = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "by id",
      }),
    );

    const msg = await server.spy.waitForMessageWithId(result.MessageId!);
    expect(msg.body).toBe("by id");
  });

  it("waitForMessageWithId matches by status", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-byid-status" }),
    );

    const result = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "by id status",
      }),
    );

    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }),
    );
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queue.QueueUrl!,
        ReceiptHandle: recv.Messages![0].ReceiptHandle!,
      }),
    );

    const msg = await server.spy.waitForMessageWithId(
      result.MessageId!,
      "consumed",
    );
    expect(msg.status).toBe("consumed");
  });

  it("filters with partial object match", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-obj-filter" }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "obj match",
      }),
    );

    const msg = server.spy.checkForMessage({
      service: "sqs",
      queueName: "spy-obj-filter",
      body: "obj match",
    });
    expect(msg).toBeDefined();
    expect(msg!.status).toBe("published");
  });

  it("filters with object match and status parameter", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-obj-status" }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "obj status",
      }),
    );

    // Should not find as consumed
    const notFound = server.spy.checkForMessage(
      { service: "sqs", queueName: "spy-obj-status" },
      "consumed",
    );
    expect(notFound).toBeUndefined();

    // Should find as published
    const found = server.spy.checkForMessage(
      { service: "sqs", queueName: "spy-obj-status" },
      "published",
    );
    expect(found).toBeDefined();
  });

  it("getAllMessages returns snapshot of buffer", async () => {
    // Clear and send fresh messages
    server.spy.clear();

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-getall" }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "msg1",
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "msg2",
      }),
    );

    const all = server.spy.getAllMessages();
    expect(all.length).toBeGreaterThanOrEqual(2);

    // Modifying returned array doesn't affect buffer
    const countBefore = server.spy.getAllMessages().length;
    all.push(all[0]);
    expect(server.spy.getAllMessages().length).toBe(countBefore);
  });

  it("clear() empties buffer and rejects pending waiters", async () => {
    const promise = server.spy.waitForMessage(
      (m) => m.body === "never-arriving-message",
    );

    server.spy.clear();

    await expect(promise).rejects.toThrow("MessageSpy cleared");
    expect(server.spy.getAllMessages()).toHaveLength(0);
  });
});

describe("MessageSpy - disabled", () => {
  it("throws when spy not enabled", async () => {
    const server = await startFauxqs({ port: 0, logger: false });
    try {
      expect(() => server.spy).toThrow("MessageSpy is not enabled");
    } finally {
      await server.stop();
    }
  });
});

describe("MessageSpy - custom bufferSize", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startSpyServer({ bufferSize: 3 });
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("evicts oldest messages when buffer is full", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "spy-buf" }),
    );

    for (let i = 0; i < 5; i++) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MessageBody: `buf-${i}`,
        }),
      );
    }

    const all = server.spy.getAllMessages();
    expect(all).toHaveLength(3);
    // Oldest messages evicted; newest remain
    expect(all[0].body).toBe("buf-2");
    expect(all[1].body).toBe("buf-3");
    expect(all[2].body).toBe("buf-4");
  });
});

describe("MessageSpy - FIFO queues", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startSpyServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("tracks published and consumed events for FIFO queues", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: "spy-fifo.fifo",
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
        },
      }),
    );

    const result = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "fifo spy test",
        MessageGroupId: "g1",
      }),
    );

    const published = server.spy.checkForMessage(
      (m) => m.messageId === result.MessageId,
      "published",
    );
    expect(published).toBeDefined();
    expect(published!.queueName).toBe("spy-fifo.fifo");

    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }),
    );
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queue.QueueUrl!,
        ReceiptHandle: recv.Messages![0].ReceiptHandle!,
      }),
    );

    const consumed = server.spy.checkForMessage(
      (m) => m.messageId === result.MessageId,
      "consumed",
    );
    expect(consumed).toBeDefined();
    expect(consumed!.queueName).toBe("spy-fifo.fifo");
  });
});
