import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS SendMessageBatch Validation (3.12)", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "batch-validation" }),
    );
    queueUrl = result.QueueUrl!;
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  describe("InvalidBatchEntryId", () => {
    it("rejects entry ID with spaces", async () => {
      await expect(
        sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: [
              { Id: "invalid id", MessageBody: "test" },
            ],
          }),
        ),
      ).rejects.toThrow("batch entry id can only contain");
    });

    it("rejects entry ID with special characters", async () => {
      await expect(
        sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: [
              { Id: "id@special!", MessageBody: "test" },
            ],
          }),
        ),
      ).rejects.toThrow("batch entry id can only contain");
    });

    it("rejects empty entry ID", async () => {
      await expect(
        sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: [
              { Id: "", MessageBody: "test" },
            ],
          }),
        ),
      ).rejects.toThrow("batch entry id can only contain");
    });

    it("accepts valid entry IDs with alphanumeric, hyphens, underscores", async () => {
      const result = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: [
            { Id: "valid-id_123", MessageBody: "test1" },
            { Id: "another-valid-ID", MessageBody: "test2" },
          ],
        }),
      );
      expect(result.Successful).toHaveLength(2);
    });
  });

  describe("BatchRequestTooLong", () => {
    it("rejects batch when total size exceeds 1 MiB", async () => {
      // Create entries that together exceed 1 MiB
      const largeBody = "x".repeat(256 * 1024); // 256 KB each
      const entries = [];
      for (let i = 0; i < 5; i++) {
        entries.push({ Id: `entry-${i}`, MessageBody: largeBody });
      }

      await expect(
        sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: entries,
          }),
        ),
      ).rejects.toThrow("Batch requests cannot be longer than");
    });

    it("accepts batch when total size is within limit", async () => {
      const body = "x".repeat(100 * 1024); // 100 KB each
      const entries = [];
      for (let i = 0; i < 5; i++) {
        entries.push({ Id: `ok-${i}`, MessageBody: body });
      }

      const result = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: entries,
        }),
      );
      expect(result.Successful).toHaveLength(5);
    });
  });
});
