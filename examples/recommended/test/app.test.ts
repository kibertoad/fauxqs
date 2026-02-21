/**
 * Integration tests — library mode.
 *
 * fauxqs runs in-process alongside the app. Each test gets a fresh server
 * instance with the spy enabled, so assertions are deterministic and fast.
 *
 * This file showcases the full programmatic API:
 *   - setup() / createQueue() / createBucket() / subscribe() for resource creation
 *   - spy.waitForMessage() with partial-object and predicate filters
 *   - spy.waitForMessages() for collecting multiple events
 *   - spy.waitForMessageWithId() for tracking a specific message
 *   - spy.expectNoMessage() for negative assertions
 *   - spy.checkForMessage() for synchronous buffer lookups
 *   - spy.getAllMessages() for full buffer access
 *   - inspectQueue() for non-destructive queue state inspection
 *   - purgeAll() for resetting all state between test groups
 *
 * Run with: npm test
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SQSClient, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { createTestContext, type TestContext } from "./context.ts";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.fauxqs.stop();
});

beforeEach(() => {
  // Clear the spy buffer between tests so assertions don't see stale events.
  // This only resets the spy — queue messages and S3 objects remain intact.
  ctx.fauxqs.spy.clear();
});

// ---------------------------------------------------------------------------
// Core app functionality
// ---------------------------------------------------------------------------

describe("POST /files/:key", () => {
  it("uploads to S3 and sends SQS notification", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/files/report.txt",
      payload: { content: "quarterly results", contentType: "text/plain" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ key: "report.txt", bucket: "app-files" });

    // --- spy.waitForMessage with partial-object filter ---
    // Resolves immediately if the event is already in the buffer (retroactive),
    // or waits for a future event. Timeout prevents tests from hanging.
    const s3Event = await ctx.fauxqs.spy.waitForMessage(
      { service: "s3", bucket: "app-files", key: "report.txt", status: "uploaded" },
      undefined,
      2000,
    );
    expect(s3Event.service).toBe("s3");

    // --- spy.waitForMessage with status shorthand ---
    // The second parameter filters by status, useful for SQS events.
    const sqsEvent = await ctx.fauxqs.spy.waitForMessage(
      { service: "sqs", queueName: "file-notifications" },
      "published",
      2000,
    );
    if (sqsEvent.service === "sqs") {
      const body = JSON.parse(sqsEvent.body);
      expect(body.event).toBe("file.uploaded");
      expect(body.key).toBe("report.txt");
    }
  });

  it("stores the correct content in S3", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/files/data.json",
      payload: { content: '{"value":42}', contentType: "application/json" },
    });

    const getResponse = await ctx.app.inject({
      method: "GET",
      url: "/files/data.json",
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.body).toBe('{"value":42}');
  });
});

describe("GET /files/:key", () => {
  it("downloads a previously uploaded file", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/files/readme.md",
      payload: { content: "# Hello" },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/files/readme.md",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("# Hello");

    // --- spy tracks S3 download events ---
    const downloadEvent = await ctx.fauxqs.spy.waitForMessage(
      { service: "s3", bucket: "app-files", key: "readme.md", status: "downloaded" },
      undefined,
      2000,
    );
    expect(downloadEvent.status).toBe("downloaded");
  });
});

// ---------------------------------------------------------------------------
// SNS fan-out and filter policies
// ---------------------------------------------------------------------------

describe("SNS fan-out", () => {
  it("delivers to all subscribed queues", async () => {
    // Upload a .json file — the app publishes to SNS with fileExtension attribute
    await ctx.app.inject({
      method: "POST",
      url: "/files/events.json",
      payload: { content: '{"data":"test"}' },
    });

    // --- spy.waitForMessage on SNS topic ---
    // SNS publish events are tracked before fan-out to SQS subscriptions.
    const snsEvent = await ctx.fauxqs.spy.waitForMessage(
      { service: "sns", topicName: "file-events", status: "published" },
      undefined,
      2000,
    );
    expect(snsEvent.service).toBe("sns");

    // Both subscribed queues should receive the message (fan-out)
    const auditEvent = await ctx.fauxqs.spy.waitForMessage(
      { service: "sqs", queueName: "audit-events", status: "published" },
      undefined,
      2000,
    );
    expect(auditEvent.service).toBe("sqs");

    const analyticsEvent = await ctx.fauxqs.spy.waitForMessage(
      { service: "sqs", queueName: "analytics-events", status: "published" },
      undefined,
      2000,
    );
    expect(analyticsEvent.service).toBe("sqs");
  });

  it("applies filter policies — only .json files reach analytics", async () => {
    // Upload a .txt file — should NOT reach analytics (filter: fileExtension=["json"])
    await ctx.app.inject({
      method: "POST",
      url: "/files/notes.txt",
      payload: { content: "plain text" },
    });

    // Audit queue receives everything (no filter policy)
    await ctx.fauxqs.spy.waitForMessage(
      { service: "sqs", queueName: "audit-events", status: "published" },
      undefined,
      2000,
    );

    // --- spy.expectNoMessage — negative assertion ---
    // Verifies that NO matching message appears within the time window.
    // Useful for testing filter policies, routing rules, and error conditions.
    await ctx.fauxqs.spy.expectNoMessage(
      { service: "sqs", queueName: "analytics-events" },
      { status: "published", within: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Spy: predicate filters, waitForMessageWithId, checkForMessage, getAllMessages
// ---------------------------------------------------------------------------

describe("spy — advanced assertions", () => {
  it("uses predicate filters for complex matching", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/files/large-report.txt",
      payload: { content: "x".repeat(1000) },
    });

    // --- spy.waitForMessage with predicate function ---
    // Full control over matching logic — access any field on the SpyMessage union.
    const event = await ctx.fauxqs.spy.waitForMessage(
      (msg) =>
        msg.service === "sqs" &&
        msg.queueName === "file-notifications" &&
        msg.body.includes("large-report.txt"),
      undefined,
      2000,
    );
    expect(event.service).toBe("sqs");
  });

  it("tracks a specific message by ID with waitForMessageWithId", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/files/tracked-by-id.txt",
      payload: { content: "find me by ID" },
    });

    // First, find the published event to get the messageId
    const published = await ctx.fauxqs.spy.waitForMessage(
      { service: "sqs", queueName: "file-notifications", status: "published" },
      undefined,
      2000,
    );

    if (published.service === "sqs") {
      // --- spy.waitForMessageWithId ---
      // Looks up a specific message ID across all events in the buffer.
      const same = await ctx.fauxqs.spy.waitForMessageWithId(
        published.messageId,
        "published",
        2000,
      );
      expect(same.service).toBe("sqs");
      if (same.service === "sqs") {
        expect(same.messageId).toBe(published.messageId);
      }
    }
  });

  it("uses checkForMessage for synchronous buffer lookups", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/files/sync-check.txt",
      payload: { content: "sync check" },
    });

    // Wait for it to arrive first
    await ctx.fauxqs.spy.waitForMessage(
      { service: "s3", key: "sync-check.txt", status: "uploaded" },
      undefined,
      2000,
    );

    // --- spy.checkForMessage — synchronous, non-blocking ---
    // Returns the message if found in the buffer, or undefined.
    // Useful when you know the event should already be there.
    const found = ctx.fauxqs.spy.checkForMessage(
      { service: "s3", bucket: "app-files", key: "sync-check.txt" },
      "uploaded",
    );
    expect(found).toBeDefined();
    expect(found!.status).toBe("uploaded");
  });

  it("uses waitForMessages to collect multiple events", async () => {
    for (const name of ["batch-a.txt", "batch-b.txt", "batch-c.txt"]) {
      await ctx.app.inject({
        method: "POST",
        url: `/files/${name}`,
        payload: { content: `content of ${name}` },
      });
    }

    // --- spy.waitForMessages — collect N matching events ---
    // Checks the buffer first (retroactive), then awaits future events.
    // Rejects on timeout with "collected M/N" for clear diagnostics.
    const messages = await ctx.fauxqs.spy.waitForMessages(
      { service: "sqs", queueName: "file-notifications", status: "published" },
      { count: 3, timeout: 2000 },
    );
    expect(messages).toHaveLength(3);
  });

  it("uses getAllMessages for full buffer access and type narrowing", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/files/narrow.json",
      payload: { content: "{}" },
    });

    // Wait for events to arrive
    await ctx.fauxqs.spy.waitForMessage(
      { service: "s3", key: "narrow.json", status: "uploaded" },
      undefined,
      2000,
    );

    // --- spy.getAllMessages — the full buffer ---
    // Returns all tracked events (oldest to newest). Each event is a
    // discriminated union on `service`, so TypeScript narrows the type
    // when you switch on msg.service.
    const allMessages = ctx.fauxqs.spy.getAllMessages();
    expect(allMessages.length).toBeGreaterThan(0);

    for (const msg of allMessages) {
      switch (msg.service) {
        case "sqs":
          // TypeScript narrows to SqsSpyMessage — has messageId, body, queueName
          expect(msg.messageId).toBeDefined();
          expect(msg.queueName).toBeDefined();
          break;
        case "sns":
          // TypeScript narrows to SnsSpyMessage — has topicArn, topicName
          expect(msg.topicArn).toBeDefined();
          break;
        case "s3":
          // TypeScript narrows to S3SpyEvent — has bucket, key
          expect(msg.bucket).toBeDefined();
          expect(msg.key).toBeDefined();
          break;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Queue inspection and state management
// ---------------------------------------------------------------------------

describe("queue inspection", () => {
  it("inspects queue state non-destructively", async () => {
    // Upload a file — this sends a message to file-notifications
    await ctx.app.inject({
      method: "POST",
      url: "/files/inspect-me.txt",
      payload: { content: "hello" },
    });

    // --- inspectQueue() — see all messages without consuming them ---
    // Returns messages grouped by state: ready, delayed, inflight.
    // Does NOT change visibility or remove messages.
    const inspection = ctx.fauxqs.inspectQueue("file-notifications");
    expect(inspection).toBeDefined();
    expect(inspection!.name).toBe("file-notifications");
    expect(inspection!.arn).toBe("arn:aws:sqs:us-east-1:000000000000:file-notifications");
    expect(inspection!.messages.ready.length).toBeGreaterThan(0);

    // Inspect the ready messages — each has messageId, body, attributes
    const readyMsg = inspection!.messages.ready[inspection!.messages.ready.length - 1];
    const body = JSON.parse(readyMsg.body);
    expect(body.event).toBe("file.uploaded");
  });

  it("shows inflight messages after receive", async () => {
    // Create a fresh queue for this test to avoid interference
    ctx.fauxqs.createQueue("inspection-demo", {
      attributes: { VisibilityTimeout: "30" },
    });

    // Send a message via the SDK to this queue
    const sqs = new SQSClient({
      endpoint: `http://127.0.0.1:${ctx.fauxqs.port}`,
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    const queueUrl = `http://sqs.us-east-1.localhost:${ctx.fauxqs.port}/000000000000/inspection-demo`;

    const { SendMessageCommand } = await import("@aws-sdk/client-sqs");
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: "inspect inflight",
    }));

    // Before receive: message is in "ready" state
    let state = ctx.fauxqs.inspectQueue("inspection-demo");
    expect(state!.messages.ready).toHaveLength(1);
    expect(state!.messages.inflight).toHaveLength(0);

    // Receive the message (makes it inflight)
    await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
    }));

    // After receive: message moves to "inflight" state
    state = ctx.fauxqs.inspectQueue("inspection-demo");
    expect(state!.messages.ready).toHaveLength(0);
    expect(state!.messages.inflight).toHaveLength(1);

    // Inflight entries include the receipt handle and visibility deadline
    const inflight = state!.messages.inflight[0];
    expect(inflight.receiptHandle).toBeDefined();
    expect(inflight.visibilityDeadline).toBeDefined();
  });

  it("returns undefined for non-existent queues", () => {
    const result = ctx.fauxqs.inspectQueue("does-not-exist");
    expect(result).toBeUndefined();
  });
});

describe("state management", () => {
  it("purgeAll resets all state", async () => {
    // Upload something to verify state exists
    await ctx.app.inject({
      method: "POST",
      url: "/files/will-be-purged.txt",
      payload: { content: "temporary" },
    });

    const before = ctx.fauxqs.inspectQueue("file-notifications");
    expect(before!.messages.ready.length).toBeGreaterThan(0);

    // --- purgeAll() — nuclear reset ---
    // Clears ALL state: queues, topics, subscriptions, buckets, and spy buffer.
    // Useful for test isolation when you need a truly clean slate.
    ctx.fauxqs.purgeAll();

    // After purge: queues no longer exist — inspectQueue returns undefined
    expect(ctx.fauxqs.inspectQueue("file-notifications")).toBeUndefined();

    // Re-create resources so subsequent tests don't break
    // (setup is idempotent — existing queues are skipped)
    ctx.fauxqs.setup({
      queues: [
        { name: "file-notifications" },
        { name: "audit-dlq" },
        {
          name: "audit-events",
          attributes: {
            VisibilityTimeout: "0",
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:audit-dlq",
              maxReceiveCount: "1",
            }),
          },
        },
        { name: "analytics-events" },
      ],
      topics: [{ name: "file-events" }],
      subscriptions: [
        { topic: "file-events", queue: "audit-events" },
        {
          topic: "file-events",
          queue: "analytics-events",
          attributes: {
            FilterPolicy: JSON.stringify({ fileExtension: ["json"] }),
          },
        },
      ],
      buckets: ["app-files"],
    });
  });
});

// ---------------------------------------------------------------------------
// DLQ tracking via spy
// ---------------------------------------------------------------------------

describe("DLQ tracking", () => {
  it("spy tracks messages moved to dead-letter queues", async () => {
    // Upload a .json file — triggers SNS fan-out to audit-events (maxReceiveCount: 1)
    await ctx.app.inject({
      method: "POST",
      url: "/files/will-dlq.json",
      payload: { content: '{"dlq":"test"}' },
    });

    // Wait for the message to arrive in audit-events
    await ctx.fauxqs.spy.waitForMessage(
      { service: "sqs", queueName: "audit-events", status: "published" },
      undefined,
      2000,
    );

    // Receive the message twice from audit-events to exceed maxReceiveCount (1).
    // With VisibilityTimeout=0, it becomes visible again immediately.
    const sqs = new SQSClient({
      endpoint: `http://127.0.0.1:${ctx.fauxqs.port}`,
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    const auditUrl = `http://sqs.us-east-1.localhost:${ctx.fauxqs.port}/000000000000/audit-events`;

    await sqs.send(new ReceiveMessageCommand({ QueueUrl: auditUrl, MaxNumberOfMessages: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: auditUrl, MaxNumberOfMessages: 1 }));

    // --- spy tracks DLQ events ---
    // When a message exceeds maxReceiveCount, fauxqs moves it to the DLQ
    // and emits a "dlq" event on the SOURCE queue (not the DLQ queue).
    const dlqEvent = await ctx.fauxqs.spy.waitForMessage(
      { service: "sqs", queueName: "audit-events", status: "dlq" },
      undefined,
      2000,
    );
    expect(dlqEvent.service).toBe("sqs");

    // Verify the DLQ message arrived via queue inspection
    const dlqState = ctx.fauxqs.inspectQueue("audit-dlq");
    expect(dlqState!.messages.ready.length).toBeGreaterThan(0);
  });
});
