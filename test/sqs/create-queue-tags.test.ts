import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  ListQueueTagsCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS CreateQueue with Tags", () => {
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

  it("creates a queue with tags via SDK and persists them", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: "tagged-queue",
        tags: { env: "test", team: "backend" },
      }),
    );

    const tags = await sqs.send(new ListQueueTagsCommand({ QueueUrl }));
    expect(tags.Tags).toEqual({ env: "test", team: "backend" });
  });

  it("creates a queue without tags and returns no tags", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: "no-tags-queue" }),
    );

    const tags = await sqs.send(new ListQueueTagsCommand({ QueueUrl }));
    // No tags set — Tags is either undefined or empty object
    const tagCount = tags.Tags ? Object.keys(tags.Tags).length : 0;
    expect(tagCount).toBe(0);
  });
});
