import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS Long Polling — concurrent receivers", () => {
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

  it("distributes messages across 3 concurrent long-poll receivers", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: "concurrent-lp" }),
    );

    // Pre-load 3 messages into the queue BEFORE starting receivers.
    // This ensures all 3 messages are available when the receivers start,
    // so each receiver can dequeue one immediately.
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-1",
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-2",
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-3",
      }),
    );

    // Start 3 concurrent ReceiveMessage requests
    const results = await Promise.all([
      sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QueueUrl!,
          WaitTimeSeconds: 5,
          MaxNumberOfMessages: 1,
        }),
      ),
      sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QueueUrl!,
          WaitTimeSeconds: 5,
          MaxNumberOfMessages: 1,
        }),
      ),
      sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QueueUrl!,
          WaitTimeSeconds: 5,
          MaxNumberOfMessages: 1,
        }),
      ),
    ]);

    // Collect all received messages across all receivers
    const allMessages = results.flatMap((r) => r.Messages ?? []);
    expect(allMessages).toHaveLength(3);

    // All 3 messages should be unique
    const bodies = allMessages.map((m) => m.Body).sort();
    expect(bodies).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("wakes a long-polling receiver when a message arrives", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: "concurrent-lp-wake" }),
    );

    // Start a single long-poll receiver on an empty queue
    const receivePromise = sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl!,
        WaitTimeSeconds: 5,
        MaxNumberOfMessages: 1,
      }),
    );

    // Wait for the receiver to register as a waiter, then send a message
    await delay(200);

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "wake-up",
      }),
    );

    const start = Date.now();
    const result = await receivePromise;
    const elapsed = Date.now() - start;

    expect(result.Messages).toHaveLength(1);
    expect(result.Messages![0].Body).toBe("wake-up");
    // Should resolve quickly after send (not waiting the full 5s)
    expect(elapsed).toBeLessThan(3000);
  });

  it("multiple receivers each get one message when sent with delays", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: "concurrent-lp-staggered" }),
    );

    // Collect results from multiple sequential long-poll + send rounds
    const received: string[] = [];

    for (let i = 0; i < 3; i++) {
      // Start receiver
      const receivePromise = sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QueueUrl!,
          WaitTimeSeconds: 5,
          MaxNumberOfMessages: 1,
        }),
      );

      // Small delay to ensure waiter is registered
      await delay(100);

      // Send one message
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: QueueUrl!,
          MessageBody: `staggered-${i}`,
        }),
      );

      const result = await receivePromise;
      expect(result.Messages).toHaveLength(1);
      received.push(result.Messages![0].Body!);
    }

    expect(received.sort()).toEqual([
      "staggered-0",
      "staggered-1",
      "staggered-2",
    ]);
  });
});
