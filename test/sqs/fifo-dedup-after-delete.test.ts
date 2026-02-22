import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS FIFO Dedup Persists After Delete", () => {
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

  it("dedup ID remains active after message is deleted", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: "dedup-del-test.fifo",
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
        },
      }),
    );

    // Send first message with explicit dedup ID
    const firstSend = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "original-message",
        MessageGroupId: "g1",
        MessageDeduplicationId: "dup1",
      }),
    );
    expect(firstSend.MessageId).toBeDefined();

    // Receive and delete the message
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl!,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("original-message");

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QueueUrl!,
        ReceiptHandle: received.Messages![0].ReceiptHandle!,
      }),
    );

    // Send same dedup ID again (within 5-minute window)
    const secondSend = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "duplicate-message",
        MessageGroupId: "g1",
        MessageDeduplicationId: "dup1",
      }),
    );

    // The send succeeds and returns the original MessageId (dedup cache hit)
    expect(secondSend.MessageId).toBe(firstSend.MessageId);

    // ReceiveMessage should return no messages because the dedup is still active
    const secondReceive = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl!,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(secondReceive.Messages).toBeUndefined();
  });
});
