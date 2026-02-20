import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
  ChangeMessageVisibilityBatchCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS batch entry ID validation for Delete and ChangeVisibility", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "batch-id-ext-queue" }),
    );
    queueUrl = result.QueueUrl!;
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  describe("DeleteMessageBatch", () => {
    it("rejects duplicate entry IDs", async () => {
      await expect(
        sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: [
              { Id: "dup", ReceiptHandle: "fake-handle-1" },
              { Id: "dup", ReceiptHandle: "fake-handle-2" },
            ],
          }),
        ),
      ).rejects.toThrow("same Id");
    });

    it("rejects invalid entry ID format", async () => {
      await expect(
        sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: [
              { Id: "invalid id!", ReceiptHandle: "fake-handle" },
            ],
          }),
        ),
      ).rejects.toThrow("batch entry id can only contain");
    });

    it("accepts valid entry IDs", async () => {
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: [
            { Id: "a", MessageBody: "msg1" },
            { Id: "b", MessageBody: "msg2" },
          ],
        }),
      );

      const recv = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 2 }),
      );

      const result = await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: recv.Messages!.map((m, i) => ({
            Id: `valid-id_${i}`,
            ReceiptHandle: m.ReceiptHandle!,
          })),
        }),
      );

      expect(result.Successful).toHaveLength(2);
    });
  });

  describe("ChangeMessageVisibilityBatch", () => {
    it("rejects duplicate entry IDs", async () => {
      await expect(
        sqs.send(
          new ChangeMessageVisibilityBatchCommand({
            QueueUrl: queueUrl,
            Entries: [
              { Id: "dup", ReceiptHandle: "fake-handle-1", VisibilityTimeout: 0 },
              { Id: "dup", ReceiptHandle: "fake-handle-2", VisibilityTimeout: 0 },
            ],
          }),
        ),
      ).rejects.toThrow("same Id");
    });

    it("rejects invalid entry ID format", async () => {
      await expect(
        sqs.send(
          new ChangeMessageVisibilityBatchCommand({
            QueueUrl: queueUrl,
            Entries: [
              { Id: "bad id@", ReceiptHandle: "fake-handle", VisibilityTimeout: 0 },
            ],
          }),
        ),
      ).rejects.toThrow("batch entry id can only contain");
    });

    it("accepts valid entry IDs", async () => {
      await sqs.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "vis-batch" }),
      );

      const recv = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl }),
      );

      const result = await sqs.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: queueUrl,
          Entries: [
            {
              Id: "valid-entry_0",
              ReceiptHandle: recv.Messages![0].ReceiptHandle!,
              VisibilityTimeout: 60,
            },
          ],
        }),
      );

      expect(result.Successful).toHaveLength(1);
    });
  });

  describe("SendMessageBatch (existing - duplicate IDs)", () => {
    it("rejects duplicate entry IDs", async () => {
      await expect(
        sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: [
              { Id: "same", MessageBody: "a" },
              { Id: "same", MessageBody: "b" },
            ],
          }),
        ),
      ).rejects.toThrow("same Id");
    });
  });
});
