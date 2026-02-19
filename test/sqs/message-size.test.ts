import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  SendMessageBatchCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS Message Size Validation", () => {
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

  it("enforces queue-level MaximumMessageSize attribute", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `size-limit-${Date.now()}`,
        Attributes: { MaximumMessageSize: "1024" },
      }),
    );

    // Small message should succeed
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "x".repeat(512),
      }),
    );

    // Message exceeding 1024 bytes should fail
    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: QueueUrl!,
          MessageBody: "x".repeat(1025),
        }),
      ),
    ).rejects.toThrow("Message must be shorter than 1024 bytes");
  });

  it("enforces updated MaximumMessageSize after SetQueueAttributes", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `size-update-${Date.now()}`,
      }),
    );

    // Set a small limit
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: QueueUrl!,
        Attributes: { MaximumMessageSize: "2048" },
      }),
    );

    // Message exceeding 2048 bytes should fail
    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: QueueUrl!,
          MessageBody: "x".repeat(2049),
        }),
      ),
    ).rejects.toThrow("Message must be shorter than 2048 bytes");
  });

  it("includes message attributes in size calculation", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `attr-size-${Date.now()}`,
        Attributes: { MaximumMessageSize: "1024" },
      }),
    );

    // Body alone is under 1024, but with attributes exceeds it
    // Body: 900 bytes, attribute name "LargeAttr" (9 bytes) + DataType "String" (6 bytes) + value 200 bytes = 1115 bytes total
    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: QueueUrl!,
          MessageBody: "x".repeat(900),
          MessageAttributes: {
            LargeAttr: { DataType: "String", StringValue: "y".repeat(200) },
          },
        }),
      ),
    ).rejects.toThrow("Message must be shorter than 1024 bytes");
  });

  it("enforces message size in batch sends", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `batch-size-${Date.now()}`,
        Attributes: { MaximumMessageSize: "1024" },
      }),
    );

    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QueueUrl!,
        Entries: [
          { Id: "ok", MessageBody: "small message" },
          { Id: "too-big", MessageBody: "x".repeat(1025) },
        ],
      }),
    );

    expect(result.Successful).toHaveLength(1);
    expect(result.Successful![0].Id).toBe("ok");
    expect(result.Failed).toHaveLength(1);
    expect(result.Failed![0].Id).toBe("too-big");
  });

  it("default MaximumMessageSize is 1 MiB", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `default-size-${Date.now()}`,
      }),
    );

    // A message just under 1 MiB should succeed
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "x".repeat(1_048_000),
      }),
    );

    // A message over 1 MiB should fail
    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: QueueUrl!,
          MessageBody: "x".repeat(1_048_577),
        }),
      ),
    ).rejects.toThrow("Message must be shorter than");
  });
});
