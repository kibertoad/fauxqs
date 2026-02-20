import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS ReceiveMessage parameter validation", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "recv-validation-queue" }),
    );
    queueUrl = result.QueueUrl!;
    await sqs.send(
      new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "test" }),
    );
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  describe("WaitTimeSeconds validation", () => {
    it("rejects WaitTimeSeconds above 20", async () => {
      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            WaitTimeSeconds: 21,
          }),
        ),
      ).rejects.toThrow("WaitTimeSeconds");
    });

    it("rejects WaitTimeSeconds below 0", async () => {
      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            WaitTimeSeconds: -1,
          }),
        ),
      ).rejects.toThrow("WaitTimeSeconds");
    });

    it("accepts WaitTimeSeconds at boundary 0", async () => {
      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            WaitTimeSeconds: 0,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("accepts WaitTimeSeconds at boundary 20", async () => {
      // Send a message so the receive returns immediately instead of waiting 20s
      await sqs.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "boundary-test" }),
      );
      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            WaitTimeSeconds: 20,
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("per-receive VisibilityTimeout validation", () => {
    it("rejects VisibilityTimeout above 43200", async () => {
      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            VisibilityTimeout: 43201,
          }),
        ),
      ).rejects.toThrow("VisibilityTimeout");
    });

    it("rejects VisibilityTimeout below 0", async () => {
      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            VisibilityTimeout: -1,
          }),
        ),
      ).rejects.toThrow("VisibilityTimeout");
    });

    it("accepts VisibilityTimeout at boundary 0", async () => {
      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            VisibilityTimeout: 0,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("accepts VisibilityTimeout at boundary 43200", async () => {
      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            VisibilityTimeout: 43200,
          }),
        ),
      ).resolves.toBeDefined();
    });
  });
});
