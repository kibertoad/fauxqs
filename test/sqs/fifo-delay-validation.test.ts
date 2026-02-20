import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS FIFO DelaySeconds Validation", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: "fifo-delay-test.fifo",
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );
    queueUrl = result.QueueUrl!;
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("rejects per-message DelaySeconds on FIFO and includes the actual value in the error", async () => {
    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: "test",
          MessageGroupId: "g1",
          DelaySeconds: 5,
        }),
      ),
    ).rejects.toThrow("Value 5 for parameter DelaySeconds is invalid");
  });

  it("includes different values in the error for different DelaySeconds", async () => {
    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: "test",
          MessageGroupId: "g1",
          DelaySeconds: 120,
        }),
      ),
    ).rejects.toThrow("Value 120 for parameter DelaySeconds is invalid");
  });

  it("allows DelaySeconds=0 on FIFO queue", async () => {
    const result = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "zero-delay",
        MessageGroupId: "g1",
        DelaySeconds: 0,
      }),
    );
    expect(result.MessageId).toBeDefined();
  });
});
