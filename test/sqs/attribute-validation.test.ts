import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS Queue Attribute Range Validation", () => {
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

  describe("CreateQueue attribute validation", () => {
    it("rejects VisibilityTimeout above 43200", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "bad-vis",
            Attributes: { VisibilityTimeout: "43201" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });

    it("rejects VisibilityTimeout below 0", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "bad-vis-neg",
            Attributes: { VisibilityTimeout: "-1" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });

    it("accepts VisibilityTimeout at boundary 0", async () => {
      const result = await sqs.send(
        new CreateQueueCommand({
          QueueName: "vis-zero",
          Attributes: { VisibilityTimeout: "0" },
        }),
      );
      expect(result.QueueUrl).toBeDefined();
    });

    it("accepts VisibilityTimeout at boundary 43200", async () => {
      const result = await sqs.send(
        new CreateQueueCommand({
          QueueName: "vis-max",
          Attributes: { VisibilityTimeout: "43200" },
        }),
      );
      expect(result.QueueUrl).toBeDefined();
    });

    it("rejects DelaySeconds above 900", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "bad-delay",
            Attributes: { DelaySeconds: "901" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });

    it("rejects ReceiveMessageWaitTimeSeconds above 20", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "bad-wait",
            Attributes: { ReceiveMessageWaitTimeSeconds: "21" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });

    it("rejects MaximumMessageSize below 1024", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "bad-size-low",
            Attributes: { MaximumMessageSize: "512" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });

    it("rejects MaximumMessageSize above 1048576", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "bad-size-high",
            Attributes: { MaximumMessageSize: "2000000" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });

    it("rejects MessageRetentionPeriod below 60", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "bad-retention-low",
            Attributes: { MessageRetentionPeriod: "30" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });

    it("rejects MessageRetentionPeriod above 1209600", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "bad-retention-high",
            Attributes: { MessageRetentionPeriod: "1209601" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });
  });

  describe("SetQueueAttributes validation", () => {
    it("rejects invalid VisibilityTimeout on existing queue", async () => {
      const { QueueUrl } = await sqs.send(
        new CreateQueueCommand({ QueueName: "set-attr-test" }),
      );

      await expect(
        sqs.send(
          new SetQueueAttributesCommand({
            QueueUrl,
            Attributes: { VisibilityTimeout: "99999" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });

    it("rejects invalid DelaySeconds on existing queue", async () => {
      const { QueueUrl } = await sqs.send(
        new CreateQueueCommand({ QueueName: "set-attr-delay" }),
      );

      await expect(
        sqs.send(
          new SetQueueAttributesCommand({
            QueueUrl,
            Attributes: { DelaySeconds: "1000" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });
  });

  describe("ReceiveMessage MaxNumberOfMessages validation", () => {
    it("rejects MaxNumberOfMessages above 10", async () => {
      const { QueueUrl } = await sqs.send(
        new CreateQueueCommand({ QueueName: "recv-max-test" }),
      );

      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl,
            MaxNumberOfMessages: 11,
          }),
        ),
      ).rejects.toThrow("MaxNumberOfMessages");
    });

    it("rejects MaxNumberOfMessages below 1", async () => {
      const { QueueUrl } = await sqs.send(
        new CreateQueueCommand({ QueueName: "recv-min-test" }),
      );

      await expect(
        sqs.send(
          new ReceiveMessageCommand({
            QueueUrl,
            MaxNumberOfMessages: 0,
          }),
        ),
      ).rejects.toThrow("MaxNumberOfMessages");
    });

    it("accepts MaxNumberOfMessages at boundaries 1 and 10", async () => {
      const { QueueUrl } = await sqs.send(
        new CreateQueueCommand({ QueueName: "recv-boundary" }),
      );

      await sqs.send(
        new SendMessageCommand({ QueueUrl, MessageBody: "test" }),
      );

      const result1 = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1 }),
      );
      expect(result1.Messages).toBeDefined();

      const result10 = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }),
      );
      // Should not throw even if no messages are available
      expect(result10).toBeDefined();
    });
  });

  describe("Non-integer attribute values", () => {
    it("rejects float value for VisibilityTimeout", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "float-vis",
            Attributes: { VisibilityTimeout: "30.5" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });

    it("rejects non-numeric string for DelaySeconds", async () => {
      await expect(
        sqs.send(
          new CreateQueueCommand({
            QueueName: "nan-delay",
            Attributes: { DelaySeconds: "abc" },
          }),
        ),
      ).rejects.toThrow("Invalid value for the parameter");
    });
  });
});
