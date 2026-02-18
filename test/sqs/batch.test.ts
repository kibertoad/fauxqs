import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  CreateQueueCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
  ChangeMessageVisibilityCommand,
  ChangeMessageVisibilityBatchCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { createTestServer, type TestServer } from "../helpers/setup.js";

describe("SQS Batch Operations", () => {
  let server: TestServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await createTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.app.close();
  });

  beforeEach(async () => {
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    );
    queueUrl = result.QueueUrl!;
  });

  it("sends a batch of messages", async () => {
    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: [
          { Id: "1", MessageBody: "message one" },
          { Id: "2", MessageBody: "message two" },
          { Id: "3", MessageBody: "message three" },
        ],
      }),
    );

    expect(result.Successful).toHaveLength(3);
    expect(result.Failed).toHaveLength(0);
    expect(result.Successful![0].Id).toBe("1");
    expect(result.Successful![0].MessageId).toBeDefined();
    expect(result.Successful![0].MD5OfMessageBody).toBeDefined();
  });

  it("deletes a batch of messages", async () => {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: [
          { Id: "1", MessageBody: "delete me 1" },
          { Id: "2", MessageBody: "delete me 2" },
        ],
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 2,
      }),
    );

    const result = await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: received.Messages!.map((m, i) => ({
          Id: String(i),
          ReceiptHandle: m.ReceiptHandle!,
        })),
      }),
    );

    expect(result.Successful).toHaveLength(2);
  });

  it("changes message visibility", async () => {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: [{ Id: "1", MessageBody: "vis test" }],
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    const receiptHandle = received.Messages![0].ReceiptHandle!;

    // Set visibility to 0 — message should become immediately available
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: 0,
      }),
    );

    const reReceived = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    expect(reReceived.Messages).toHaveLength(1);
    expect(reReceived.Messages![0].Body).toBe("vis test");
  });

  it("changes visibility in batch", async () => {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: [
          { Id: "1", MessageBody: "batch vis 1" },
          { Id: "2", MessageBody: "batch vis 2" },
        ],
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 2,
      }),
    );

    // Make both messages immediately visible again
    const result = await sqs.send(
      new ChangeMessageVisibilityBatchCommand({
        QueueUrl: queueUrl,
        Entries: received.Messages!.map((m, i) => ({
          Id: String(i),
          ReceiptHandle: m.ReceiptHandle!,
          VisibilityTimeout: 0,
        })),
      }),
    );

    expect(result.Successful).toHaveLength(2);

    // Both should be visible again
    const reReceived = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
      }),
    );
    expect(reReceived.Messages).toHaveLength(2);
  });
});
