import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS ChangeMessageVisibility range validation", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;
  let receiptHandle: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "vis-validation-queue" }),
    );
    queueUrl = result.QueueUrl!;

    await sqs.send(
      new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "test" }),
    );
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    receiptHandle = recv.Messages![0].ReceiptHandle!;
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("rejects VisibilityTimeout above 43200", async () => {
    await expect(
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 43201,
        }),
      ),
    ).rejects.toThrow("VisibilityTimeout");
  });

  it("rejects VisibilityTimeout below 0", async () => {
    await expect(
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: -1,
        }),
      ),
    ).rejects.toThrow("VisibilityTimeout");
  });

  it("accepts VisibilityTimeout at boundary 0", async () => {
    await expect(
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("accepts VisibilityTimeout at boundary 43200", async () => {
    // Re-receive the message first (it was made visible by the previous test)
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    const handle = recv.Messages![0].ReceiptHandle!;

    await expect(
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: handle,
          VisibilityTimeout: 43200,
        }),
      ),
    ).resolves.toBeDefined();
  });
});
