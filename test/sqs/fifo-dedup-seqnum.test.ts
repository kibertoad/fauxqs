import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS FIFO Deduplication Sequence Number", () => {
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

  it("returns original sequence number on duplicate SendMessage", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `dedup-seq-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true" },
      }),
    );

    const first = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "original",
        MessageGroupId: "group1",
        MessageDeduplicationId: "dedup-1",
      }),
    );

    const duplicate = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "duplicate",
        MessageGroupId: "group1",
        MessageDeduplicationId: "dedup-1",
      }),
    );

    // Duplicate should return same MessageId and same SequenceNumber
    expect(duplicate.MessageId).toBe(first.MessageId);
    expect(duplicate.SequenceNumber).toBe(first.SequenceNumber);
  });

  it("returns original sequence number on duplicate in batch", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `batch-dedup-seq-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true" },
      }),
    );

    // Send first message
    const first = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "original",
        MessageGroupId: "group1",
        MessageDeduplicationId: "batch-dedup-1",
      }),
    );

    // Send duplicate in a batch
    const batch = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QueueUrl!,
        Entries: [
          {
            Id: "dup",
            MessageBody: "duplicate",
            MessageGroupId: "group1",
            MessageDeduplicationId: "batch-dedup-1",
          },
        ],
      }),
    );

    expect(batch.Successful).toHaveLength(1);
    expect(batch.Successful![0].MessageId).toBe(first.MessageId);
    expect(batch.Successful![0].SequenceNumber).toBe(first.SequenceNumber);
  });

  it("does not increment sequence counter on dedup", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `seq-counter-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true" },
      }),
    );

    const first = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-1",
        MessageGroupId: "group1",
        MessageDeduplicationId: "unique-1",
      }),
    );

    // Send duplicate - should not consume a sequence number
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-1-dup",
        MessageGroupId: "group1",
        MessageDeduplicationId: "unique-1",
      }),
    );

    // Send a new message - its sequence number should be first + 1, not first + 2
    const third = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-2",
        MessageGroupId: "group1",
        MessageDeduplicationId: "unique-2",
      }),
    );

    const firstSeq = parseInt(first.SequenceNumber!);
    const thirdSeq = parseInt(third.SequenceNumber!);
    expect(thirdSeq).toBe(firstSeq + 1);
  });
});
