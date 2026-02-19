import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS Long Polling", () => {
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

  it("returns immediately when messages are available", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "poll-immediate" }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "already here",
      }),
    );

    const start = Date.now();
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        WaitTimeSeconds: 5,
      }),
    );
    const elapsed = Date.now() - start;

    expect(result.Messages).toHaveLength(1);
    expect(elapsed).toBeLessThan(2000);
  });

  it("waits for a message to arrive", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "poll-wait" }),
    );

    // Send a message after 500ms
    delay(500).then(async () => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MessageBody: "delayed arrival",
        }),
      );
    });

    const start = Date.now();
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        WaitTimeSeconds: 5,
      }),
    );
    const elapsed = Date.now() - start;

    expect(result.Messages).toHaveLength(1);
    expect(result.Messages![0].Body).toBe("delayed arrival");
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(3000);
  });

  it("returns empty after timeout", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "poll-timeout" }),
    );

    const start = Date.now();
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        WaitTimeSeconds: 1,
      }),
    );
    const elapsed = Date.now() - start;

    expect(result.Messages).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("SQS Long Polling — timer processing during wait", () => {
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

  it("delivers delayed message during long-poll wait", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "poll-delayed-msg" }),
    );

    // Send a message with 1-second delay
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "delayed-body",
        DelaySeconds: 1,
      }),
    );

    // Long-poll should wait, then receive the delayed message once it becomes available
    const start = Date.now();
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        WaitTimeSeconds: 5,
      }),
    );
    const elapsed = Date.now() - start;

    expect(result.Messages).toHaveLength(1);
    expect(result.Messages![0].Body).toBe("delayed-body");
    // Should have waited at least ~1 second for the delay
    expect(elapsed).toBeGreaterThanOrEqual(900);
    // But not the full 5 second wait time
    expect(elapsed).toBeLessThan(3000);
  });

  it("returns message when visibility timeout expires during long-poll", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: "poll-vis-expire",
        Attributes: { VisibilityTimeout: "1" },
      }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "vis-timeout-body",
      }),
    );

    // First consumer receives the message (visibility timeout = 1s)
    const first = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }),
    );
    expect(first.Messages).toHaveLength(1);

    // Second consumer long-polls — should get the message after visibility timeout expires
    const start = Date.now();
    const second = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        WaitTimeSeconds: 5,
      }),
    );
    const elapsed = Date.now() - start;

    expect(second.Messages).toHaveLength(1);
    expect(second.Messages![0].Body).toBe("vis-timeout-body");
    // Should have waited ~1 second for visibility timeout to expire
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("SQS Long Polling — shutdown", () => {
  it("releases pending long-poll waiters when server closes", async () => {
    const shutdownServer = await startFauxqsTestServer();
    const shutdownSqs = createSqsClient(shutdownServer.port);

    const queue = await shutdownSqs.send(
      new CreateQueueCommand({ QueueName: "poll-shutdown" }),
    );

    // Start a long-poll that would normally wait 20 seconds
    let pollSettled = false;
    const _pollPromise = shutdownSqs
      .send(
        new ReceiveMessageCommand({
          QueueUrl: queue.QueueUrl!,
          WaitTimeSeconds: 20,
        }),
      )
      .catch(() => null)
      .finally(() => {
        pollSettled = true;
      });

    // Give the request time to reach the server and start waiting
    await delay(100);

    // Close the server — preClose hook should release waiters, then forceCloseConnections tears down sockets
    await shutdownServer.stop();

    // The poll request should settle promptly after server close
    await vi.waitFor(() => expect(pollSettled).toBe(true), { timeout: 2000 });

    shutdownSqs.destroy();
  });
});
