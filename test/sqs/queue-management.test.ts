import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  PurgeQueueCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { createTestServer, type TestServer } from "../helpers/setup.js";

describe("SQS Queue Management", () => {
  let server: TestServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await createTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.app.close();
  });

  it("creates a queue and returns its URL", async () => {
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "test-queue" }),
    );
    expect(result.QueueUrl).toContain("test-queue");
    expect(result.QueueUrl).toContain("000000000000");
  });

  it("is idempotent for same name and attributes", async () => {
    const result1 = await sqs.send(
      new CreateQueueCommand({ QueueName: "idempotent-queue" }),
    );
    const result2 = await sqs.send(
      new CreateQueueCommand({ QueueName: "idempotent-queue" }),
    );
    expect(result1.QueueUrl).toBe(result2.QueueUrl);
  });

  it("gets queue URL by name", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "url-lookup-queue" }),
    );
    const result = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "url-lookup-queue" }),
    );
    expect(result.QueueUrl).toBe(created.QueueUrl);
  });

  it("lists queues", async () => {
    await sqs.send(
      new CreateQueueCommand({ QueueName: "list-queue-a" }),
    );
    await sqs.send(
      new CreateQueueCommand({ QueueName: "list-queue-b" }),
    );

    const result = await sqs.send(new ListQueuesCommand({}));
    const urls = result.QueueUrls ?? [];
    expect(urls.some((u) => u.includes("list-queue-a"))).toBe(true);
    expect(urls.some((u) => u.includes("list-queue-b"))).toBe(true);
  });

  it("lists queues with prefix filter", async () => {
    await sqs.send(
      new CreateQueueCommand({ QueueName: "prefix-alpha" }),
    );
    await sqs.send(
      new CreateQueueCommand({ QueueName: "prefix-beta" }),
    );
    await sqs.send(
      new CreateQueueCommand({ QueueName: "other-queue" }),
    );

    const result = await sqs.send(
      new ListQueuesCommand({ QueueNamePrefix: "prefix-" }),
    );
    const urls = result.QueueUrls ?? [];
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.every((u) => u.includes("prefix-"))).toBe(true);
  });

  it("gets queue attributes", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: "attr-queue",
        Attributes: { VisibilityTimeout: "60" },
      }),
    );

    const result = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["All"],
      }),
    );

    expect(result.Attributes?.VisibilityTimeout).toBe("60");
    expect(result.Attributes?.QueueArn).toContain("attr-queue");
    expect(result.Attributes?.DelaySeconds).toBe("0");
  });

  it("sets queue attributes", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "set-attr-queue" }),
    );

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        Attributes: { VisibilityTimeout: "120" },
      }),
    );

    const result = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["VisibilityTimeout"],
      }),
    );

    expect(result.Attributes?.VisibilityTimeout).toBe("120");
  });

  it("deletes a queue", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "delete-me-queue" }),
    );

    await sqs.send(
      new DeleteQueueCommand({ QueueUrl: created.QueueUrl }),
    );

    // Queue should no longer be listable
    const list = await sqs.send(new ListQueuesCommand({}));
    const urls = list.QueueUrls ?? [];
    expect(urls.some((u) => u.includes("delete-me-queue"))).toBe(false);
  });

  it("creates queue with custom attributes", async () => {
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: "custom-attrs-queue",
        Attributes: {
          DelaySeconds: "5",
          MaximumMessageSize: "1024",
          MessageRetentionPeriod: "86400",
          ReceiveMessageWaitTimeSeconds: "10",
        },
      }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: result.QueueUrl,
        AttributeNames: ["All"],
      }),
    );

    expect(attrs.Attributes?.DelaySeconds).toBe("5");
    expect(attrs.Attributes?.MaximumMessageSize).toBe("1024");
    expect(attrs.Attributes?.MessageRetentionPeriod).toBe("86400");
    expect(attrs.Attributes?.ReceiveMessageWaitTimeSeconds).toBe("10");
  });

  it("purges a queue", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "purge-queue" }),
    );

    await sqs.send(
      new PurgeQueueCommand({ QueueUrl: created.QueueUrl }),
    );

    // Should succeed without error (queue is empty, purge is still valid)
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("0");
  });
});
