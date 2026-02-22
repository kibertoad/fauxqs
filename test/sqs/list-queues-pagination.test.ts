import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  ListQueuesCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS ListQueues Pagination", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);

    // Create 5 queues with a common prefix
    for (const suffix of ["a", "b", "c", "d", "e"]) {
      await sqs.send(
        new CreateQueueCommand({ QueueName: `page-q-${suffix}` }),
      );
    }
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("paginates with MaxResults=2 across three pages", async () => {
    // Page 1: first 2 results
    const page1 = await sqs.send(
      new ListQueuesCommand({ MaxResults: 2 }),
    );
    expect(page1.QueueUrls).toHaveLength(2);
    expect(page1.NextToken).toBeDefined();

    // Page 2: next 2 results
    const page2 = await sqs.send(
      new ListQueuesCommand({ MaxResults: 2, NextToken: page1.NextToken }),
    );
    expect(page2.QueueUrls).toHaveLength(2);
    expect(page2.NextToken).toBeDefined();

    // Page 3: last 1 result
    const page3 = await sqs.send(
      new ListQueuesCommand({ MaxResults: 2, NextToken: page2.NextToken }),
    );
    expect(page3.QueueUrls).toHaveLength(1);
    expect(page3.NextToken).toBeUndefined();
  });

  it("combines prefix filter with MaxResults pagination", async () => {
    // Page 1: prefix filter + MaxResults=2
    const page1 = await sqs.send(
      new ListQueuesCommand({ QueueNamePrefix: "page-q-", MaxResults: 2 }),
    );
    expect(page1.QueueUrls).toHaveLength(2);
    expect(page1.NextToken).toBeDefined();
    expect(page1.QueueUrls!.every((u) => u.includes("page-q-"))).toBe(true);

    // Page 2
    const page2 = await sqs.send(
      new ListQueuesCommand({
        QueueNamePrefix: "page-q-",
        MaxResults: 2,
        NextToken: page1.NextToken,
      }),
    );
    expect(page2.QueueUrls).toHaveLength(2);
    expect(page2.NextToken).toBeDefined();
    expect(page2.QueueUrls!.every((u) => u.includes("page-q-"))).toBe(true);

    // Page 3: last page
    const page3 = await sqs.send(
      new ListQueuesCommand({
        QueueNamePrefix: "page-q-",
        MaxResults: 2,
        NextToken: page2.NextToken,
      }),
    );
    expect(page3.QueueUrls).toHaveLength(1);
    expect(page3.NextToken).toBeUndefined();
    expect(page3.QueueUrls!.every((u) => u.includes("page-q-"))).toBe(true);

    // All 5 queue URLs should be unique across all pages
    const allUrls = [
      ...page1.QueueUrls!,
      ...page2.QueueUrls!,
      ...page3.QueueUrls!,
    ];
    expect(new Set(allUrls).size).toBe(5);
  });

  it("returns all queues without MaxResults (no NextToken)", async () => {
    const result = await sqs.send(
      new ListQueuesCommand({ QueueNamePrefix: "page-q-" }),
    );
    expect(result.QueueUrls).toHaveLength(5);
    expect(result.NextToken).toBeUndefined();
  });

  it("NextToken is absent when results are exhausted", async () => {
    // Request with MaxResults larger than total queues
    const result = await sqs.send(
      new ListQueuesCommand({ QueueNamePrefix: "page-q-", MaxResults: 10 }),
    );
    expect(result.QueueUrls).toHaveLength(5);
    expect(result.NextToken).toBeUndefined();
  });
});
