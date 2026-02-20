import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

/**
 * This test simulates the real-world scenario from conversation-service:
 * - A consumer continuously polls a FIFO queue (like sqs-consumer does)
 * - Between tests, the queue is deleted and recreated
 * - Both tests use the same MessageGroupId
 *
 * The key pattern: when a consumer deletes a message and immediately starts
 * a new long-poll, there's a window where the group might still appear "locked"
 * if the lock cleanup and the next dequeue race.
 */
describe("FIFO consumer simulation: delete-recreate with same MessageGroupId", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  const queueName = "consumer-sim.fifo";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  /**
   * Simulates sqs-consumer behavior: continuous polling loop that
   * receives, processes, and deletes messages.
   */
  async function runConsumerUntilMessage(
    queueUrl: string,
    signal: AbortSignal,
  ): Promise<{ body: string; receiptHandle: string }> {
    while (!signal.aborted) {
      try {
        const result = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            WaitTimeSeconds: 2,
            MaxNumberOfMessages: 1,
            MessageAttributeNames: ["payloadOffloading.*"],
          }),
        );

        if (result.Messages && result.Messages.length > 0) {
          const msg = result.Messages[0];
          // Simulate processing then delete
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle!,
            }),
          );
          return { body: msg.Body!, receiptHandle: msg.ReceiptHandle! };
        }
      } catch {
        if (signal.aborted) break;
      }
    }
    throw new Error("Consumer aborted without receiving a message");
  }

  it("test 1: consumer receives message from test-group", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
        },
      }),
    );

    const ac = new AbortController();

    // Start consumer polling
    const consumerPromise = runConsumerUntilMessage(QueueUrl!, ac.signal);

    // Give consumer time to start polling
    await new Promise((r) => setTimeout(r, 50));

    // Publish message
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: JSON.stringify({ userId: "user-1", type: "Added" }),
        MessageGroupId: "test-group",
      }),
    );

    const consumed = await consumerPromise;
    expect(JSON.parse(consumed.body).userId).toBe("user-1");

    // Stop consumer
    ac.abort();
  });

  it("test 2: after delete-recreate, consumer receives from SAME test-group", async () => {
    // Delete old queue
    try {
      const { GetQueueUrlCommand } = await import("@aws-sdk/client-sqs");
      const urlResp = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: urlResp.QueueUrl! }));
    } catch {
      // Queue might not exist
    }

    // Recreate fresh queue
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
        },
      }),
    );

    const ac = new AbortController();

    // Start consumer polling
    const consumerPromise = runConsumerUntilMessage(QueueUrl!, ac.signal);

    // Give consumer time to start polling
    await new Promise((r) => setTimeout(r, 50));

    // Publish message with SAME MessageGroupId
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: JSON.stringify({ userId: "user-2", type: "Deleted" }),
        MessageGroupId: "test-group",
      }),
    );

    const consumed = await consumerPromise;
    expect(JSON.parse(consumed.body).userId).toBe("user-2");

    ac.abort();
  });
});

describe("FIFO: concurrent long-poll during message processing", () => {
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

  it("message published while group is locked becomes available after delete", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `concurrent-fifo-${Date.now()}.fifo`,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
        },
      }),
    );

    // Send first message
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-1",
        MessageGroupId: "test-group",
      }),
    );

    // Receive it (locks group)
    const first = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(first.Messages).toHaveLength(1);

    // Send second message while group is locked
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-2",
        MessageGroupId: "test-group",
      }),
    );

    // Start a long-poll — group is locked so this should wait
    const longPollPromise = sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl!,
        WaitTimeSeconds: 5,
      }),
    );

    // Give long-poll time to register
    await new Promise((r) => setTimeout(r, 50));

    // Delete first message — unlocks group
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QueueUrl!,
        ReceiptHandle: first.Messages![0].ReceiptHandle!,
      }),
    );

    // The long-poll should now receive msg-2
    const result = await longPollPromise;
    expect(result.Messages).toHaveLength(1);
    expect(result.Messages![0].Body).toBe("msg-2");
  });
});
