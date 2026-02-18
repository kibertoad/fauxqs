import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS FIFO Queues", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("creates a FIFO queue with .fifo suffix", async () => {
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: "my-queue.fifo",
        Attributes: { FifoQueue: "true" },
      }),
    );
    expect(result.QueueUrl).toContain("my-queue.fifo");

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: result.QueueUrl!,
        AttributeNames: ["All"],
      }),
    );
    expect(attrs.Attributes?.FifoQueue).toBe("true");
    expect(attrs.Attributes?.ContentBasedDeduplication).toBe("false");
    expect(attrs.Attributes?.DeduplicationScope).toBe("queue");
    expect(attrs.Attributes?.FifoThroughputLimit).toBe("perQueue");
  });

  it("auto-sets FifoQueue when name ends with .fifo", async () => {
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "auto-fifo.fifo" }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: result.QueueUrl!,
        AttributeNames: ["FifoQueue"],
      }),
    );
    expect(attrs.Attributes?.FifoQueue).toBe("true");
  });

  it("rejects FifoQueue=true without .fifo suffix", async () => {
    await expect(
      sqs.send(
        new CreateQueueCommand({
          QueueName: "not-fifo",
          Attributes: { FifoQueue: "true" },
        }),
      ),
    ).rejects.toThrow("must end with .fifo suffix");
  });

  it("sends and receives with MessageGroupId preserving order", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `order-test-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    // Send 3 messages to the same group
    for (let i = 0; i < 3; i++) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: QueueUrl!,
          MessageBody: `message-${i}`,
          MessageGroupId: "group1",
        }),
      );
    }

    // Receive them and verify order
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl!,
        MaxNumberOfMessages: 10,
      }),
    );

    // FIFO: only one message per group per ReceiveMessage (group locking)
    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("message-0");

    // Delete first, then get next
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QueueUrl!,
        ReceiptHandle: received.Messages![0].ReceiptHandle!,
      }),
    );

    const second = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(second.Messages).toHaveLength(1);
    expect(second.Messages![0].Body).toBe("message-1");

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QueueUrl!,
        ReceiptHandle: second.Messages![0].ReceiptHandle!,
      }),
    );

    const third = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(third.Messages).toHaveLength(1);
    expect(third.Messages![0].Body).toBe("message-2");
  });

  it("locks message group when a message is inflight", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `lock-test-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-1",
        MessageGroupId: "groupA",
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-2",
        MessageGroupId: "groupA",
      }),
    );

    // Receive first message (locks groupA)
    const first = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(first.Messages).toHaveLength(1);
    expect(first.Messages![0].Body).toBe("msg-1");

    // Second receive should return nothing (group is locked)
    const second = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(second.Messages).toBeUndefined();

    // Delete first message to unlock group
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QueueUrl!,
        ReceiptHandle: first.Messages![0].ReceiptHandle!,
      }),
    );

    // Now second message should be available
    const third = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(third.Messages).toHaveLength(1);
    expect(third.Messages![0].Body).toBe("msg-2");
  });

  it("allows concurrent receive from different groups", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `multi-group-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "groupA-msg",
        MessageGroupId: "groupA",
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "groupB-msg",
        MessageGroupId: "groupB",
      }),
    );

    // Receive from groupA
    const first = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(first.Messages).toHaveLength(1);

    // Should still be able to receive from groupB
    const second = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(second.Messages).toHaveLength(1);

    // Messages are from different groups
    const bodies = [first.Messages![0].Body, second.Messages![0].Body].sort();
    expect(bodies).toEqual(["groupA-msg", "groupB-msg"]);
  });

  it("deduplicates with content-based deduplication", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `cbd-test-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    const first = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "same-body",
        MessageGroupId: "group1",
      }),
    );

    // Send same body again — should be deduplicated
    const second = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "same-body",
        MessageGroupId: "group1",
      }),
    );

    // Both return the same MessageId (original)
    expect(second.MessageId).toBe(first.MessageId);

    // Only one message should be in the queue
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl!,
        MaxNumberOfMessages: 10,
      }),
    );
    expect(received.Messages).toHaveLength(1);
  });

  it("deduplicates with explicit deduplication ID", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `dedup-explicit-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true" },
      }),
    );

    const first = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "body-1",
        MessageGroupId: "group1",
        MessageDeduplicationId: "dedup-123",
      }),
    );

    // Send different body but same dedup ID — should be deduplicated
    const second = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "body-2",
        MessageGroupId: "group1",
        MessageDeduplicationId: "dedup-123",
      }),
    );

    expect(second.MessageId).toBe(first.MessageId);

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl!,
        MaxNumberOfMessages: 10,
      }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("body-1");
  });

  it("errors when MessageGroupId is missing on FIFO queue", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `no-group-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: QueueUrl!,
          MessageBody: "test",
        }),
      ),
    ).rejects.toThrow("MessageGroupId");
  });

  it("errors when MessageDeduplicationId missing and no ContentBasedDedup", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `no-dedup-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true" },
      }),
    );

    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: QueueUrl!,
          MessageBody: "test",
          MessageGroupId: "group1",
        }),
      ),
    ).rejects.toThrow("ContentBasedDeduplication");
  });

  it("returns SequenceNumber in send response and system attributes", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `seq-test-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "seq-msg",
        MessageGroupId: "group1",
      }),
    );
    expect(sent.SequenceNumber).toBeDefined();

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl!,
        AttributeNames: ["All"],
      }),
    );

    const attrs = received.Messages![0].Attributes!;
    expect(attrs.SequenceNumber).toBe(sent.SequenceNumber);
    expect(attrs.MessageGroupId).toBe("group1");
    expect(attrs.MessageDeduplicationId).toBeDefined();
  });

  it("handles batch send with FIFO", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `batch-fifo-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QueueUrl!,
        Entries: [
          { Id: "1", MessageBody: "batch-1", MessageGroupId: "group1" },
          { Id: "2", MessageBody: "batch-2", MessageGroupId: "group1" },
          { Id: "3", MessageBody: "batch-3", MessageGroupId: "group2" },
        ],
      }),
    );

    expect(result.Successful).toHaveLength(3);
    for (const entry of result.Successful!) {
      expect(entry.SequenceNumber).toBeDefined();
    }
  });

  it("visibility timeout expiry re-enqueues to front of group", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `vis-fifo-${Date.now()}.fifo`,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
          VisibilityTimeout: "1",
        },
      }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-1",
        MessageGroupId: "group1",
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-2",
        MessageGroupId: "group1",
      }),
    );

    // Receive first message
    const first = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(first.Messages![0].Body).toBe("msg-1");

    // Wait for visibility timeout to expire
    await new Promise((r) => setTimeout(r, 1500));

    // Message should be re-enqueued at front of group
    const retry = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(retry.Messages).toHaveLength(1);
    expect(retry.Messages![0].Body).toBe("msg-1");
  });

  it("DLQ with FIFO moves to FIFO DLQ", async () => {
    const dlq = await sqs.send(
      new CreateQueueCommand({
        QueueName: `fifo-dlq-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true" },
      }),
    );
    const dlqAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    const source = await sqs.send(
      new CreateQueueCommand({
        QueueName: `fifo-src-${Date.now()}.fifo`,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
          VisibilityTimeout: "1",
        },
      }),
    );

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: source.QueueUrl!,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqAttrs.Attributes!.QueueArn,
            maxReceiveCount: 2,
          }),
        },
      }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: source.QueueUrl!,
        MessageBody: "fifo-dlq-test",
        MessageGroupId: "group1",
        MessageDeduplicationId: "unique-for-dlq-test",
      }),
    );

    // Receive 1st time
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    await new Promise((r) => setTimeout(r, 1200));

    // Receive 2nd time
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    await new Promise((r) => setTimeout(r, 1200));

    // 3rd receive triggers DLQ
    const thirdReceive = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    expect(thirdReceive.Messages).toBeUndefined();

    // DLQ should have the message
    const dlqMessages = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq.QueueUrl! }),
    );
    expect(dlqMessages.Messages).toHaveLength(1);
    expect(dlqMessages.Messages![0].Body).toBe("fifo-dlq-test");
  });

  it("allows changing ContentBasedDeduplication on existing FIFO queue", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `change-cbd-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true" },
      }),
    );

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: QueueUrl!,
        Attributes: { ContentBasedDeduplication: "true" },
      }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: QueueUrl!,
        AttributeNames: ["ContentBasedDeduplication"],
      }),
    );
    expect(attrs.Attributes?.ContentBasedDeduplication).toBe("true");
  });

  it("returns correct ApproximateNumberOfMessages for FIFO", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `count-fifo-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "count-1",
        MessageGroupId: "g1",
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "count-2",
        MessageGroupId: "g2",
      }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: QueueUrl!,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("2");
  });
});
