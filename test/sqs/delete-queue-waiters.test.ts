import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS DeleteQueue waiter cleanup", () => {
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

  it("cancels active long-poll waiters when queue is deleted", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `del-waiter-${Date.now()}`,
      }),
    );

    // Start a long-poll that would wait 20 seconds
    const longPollPromise = sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl!,
        WaitTimeSeconds: 20,
      }),
    );

    // Give the long-poll a moment to register
    await new Promise((r) => setTimeout(r, 100));

    // Delete the queue — should cancel the waiter
    await sqs.send(new DeleteQueueCommand({ QueueUrl: QueueUrl! }));

    // The long-poll should resolve quickly (not wait 20 seconds)
    const start = Date.now();
    const result = await longPollPromise;
    const elapsed = Date.now() - start;

    // Should have resolved in well under the 20 second wait time
    expect(elapsed).toBeLessThan(5000);
    // Should return empty (no messages)
    expect(result.Messages).toBeUndefined();
  });
});
