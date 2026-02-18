import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
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
    setTimeout(async () => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MessageBody: "delayed arrival",
        }),
      );
    }, 500);

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
