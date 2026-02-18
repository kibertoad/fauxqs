import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  TagQueueCommand,
  UntagQueueCommand,
  ListQueueTagsCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS Queue Tags", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "tags-test-queue" }),
    );
    queueUrl = result.QueueUrl!;
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("tags a queue", async () => {
    await sqs.send(
      new TagQueueCommand({
        QueueUrl: queueUrl,
        Tags: { env: "test", team: "backend" },
      }),
    );

    const result = await sqs.send(
      new ListQueueTagsCommand({ QueueUrl: queueUrl }),
    );

    expect(result.Tags).toEqual({ env: "test", team: "backend" });
  });

  it("adds more tags", async () => {
    await sqs.send(
      new TagQueueCommand({
        QueueUrl: queueUrl,
        Tags: { version: "1.0" },
      }),
    );

    const result = await sqs.send(
      new ListQueueTagsCommand({ QueueUrl: queueUrl }),
    );

    expect(result.Tags).toEqual({
      env: "test",
      team: "backend",
      version: "1.0",
    });
  });

  it("removes tags", async () => {
    await sqs.send(
      new UntagQueueCommand({
        QueueUrl: queueUrl,
        TagKeys: ["team"],
      }),
    );

    const result = await sqs.send(
      new ListQueueTagsCommand({ QueueUrl: queueUrl }),
    );

    expect(result.Tags).toEqual({ env: "test", version: "1.0" });
  });

  it("overwrites existing tag values", async () => {
    await sqs.send(
      new TagQueueCommand({
        QueueUrl: queueUrl,
        Tags: { env: "production" },
      }),
    );

    const result = await sqs.send(
      new ListQueueTagsCommand({ QueueUrl: queueUrl }),
    );

    expect(result.Tags?.env).toBe("production");
  });
});
