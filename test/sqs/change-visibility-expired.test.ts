import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS ChangeMessageVisibility on expired receipt", () => {
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

  it("rejects ChangeMessageVisibility after visibility timeout expires", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: "vis-expired-queue",
        Attributes: { VisibilityTimeout: "1" },
      }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "expiring-message",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(received.Messages).toHaveLength(1);
    const receiptHandle = received.Messages![0].ReceiptHandle!;

    // Wait for visibility timeout to expire (1s timeout + 1s buffer)
    await delay(2000);

    // Trigger processTimers() so the expired message is moved out of inflight
    // back to the ready queue. A short-poll ReceiveMessage call does this.
    const reReceived = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    // The message is now re-available and received again with a new receipt handle
    expect(reReceived.Messages).toHaveLength(1);

    // Attempt to change visibility on the OLD (now invalid) receipt handle
    await expect(
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: QueueUrl!,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 30,
        }),
      ),
    ).rejects.toThrow("Message does not exist or is not available for visibility timeout change");
  });
});
