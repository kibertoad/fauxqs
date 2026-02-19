import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqs, type FauxqsServer } from "../../src/app.js";

describe("Queue inspection - programmatic API", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false });
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("returns undefined for non-existent queue", () => {
    expect(server.inspectQueue("no-such-queue")).toBeUndefined();
  });

  it("inspects an empty queue", async () => {
    await sqs.send(new CreateQueueCommand({ QueueName: "inspect-empty" }));

    const result = server.inspectQueue("inspect-empty");
    expect(result).toBeDefined();
    expect(result!.name).toBe("inspect-empty");
    expect(result!.arn).toContain("inspect-empty");
    expect(result!.messages.ready).toHaveLength(0);
    expect(result!.messages.delayed).toHaveLength(0);
    expect(result!.messages.inflight).toHaveLength(0);
    expect(result!.attributes.VisibilityTimeout).toBe("30");
  });

  it("shows ready messages without consuming them", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "inspect-ready" }));

    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "msg-1" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "msg-2" }));

    const result = server.inspectQueue("inspect-ready")!;
    expect(result.messages.ready).toHaveLength(2);
    expect(result.messages.ready[0].body).toBe("msg-1");
    expect(result.messages.ready[1].body).toBe("msg-2");

    // Messages should still be there after inspection
    const result2 = server.inspectQueue("inspect-ready")!;
    expect(result2.messages.ready).toHaveLength(2);
  });

  it("shows in-flight messages", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "inspect-inflight" }));

    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "inflight-msg" }),
    );

    // Receive the message (makes it in-flight)
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }));

    const result = server.inspectQueue("inspect-inflight")!;
    expect(result.messages.ready).toHaveLength(0);
    expect(result.messages.inflight).toHaveLength(1);
    expect(result.messages.inflight[0].message.body).toBe("inflight-msg");
    expect(result.messages.inflight[0].receiptHandle).toBeDefined();
    expect(result.messages.inflight[0].visibilityDeadline).toBeGreaterThan(Date.now());
  });

  it("shows delayed messages", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "inspect-delayed" }));

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "delayed-msg",
        DelaySeconds: 900,
      }),
    );

    const result = server.inspectQueue("inspect-delayed")!;
    expect(result.messages.ready).toHaveLength(0);
    expect(result.messages.delayed).toHaveLength(1);
    expect(result.messages.delayed[0].body).toBe("delayed-msg");
    expect(result.messages.delayed[0].delayUntil).toBeGreaterThan(Date.now());
  });

  it("shows messages across all states simultaneously", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "inspect-all-states", Attributes: { VisibilityTimeout: "60" } }),
    );

    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "msg-a" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "msg-b" }));
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "delayed-msg",
        DelaySeconds: 900,
      }),
    );

    // Receive one message to make it in-flight (takes first available: msg-a)
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl!, MaxNumberOfMessages: 1 }),
    );

    const result = server.inspectQueue("inspect-all-states")!;
    expect(result.messages.ready).toHaveLength(1);
    expect(result.messages.ready[0].body).toBe("msg-b");
    expect(result.messages.inflight).toHaveLength(1);
    expect(result.messages.inflight[0].message.body).toBe("msg-a");
    expect(result.messages.delayed).toHaveLength(1);
    expect(result.messages.delayed[0].body).toBe("delayed-msg");
  });

  it("inspects FIFO queue messages", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: "inspect-fifo.fifo",
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "fifo-msg-1",
        MessageGroupId: "g1",
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "fifo-msg-2",
        MessageGroupId: "g2",
      }),
    );

    const result = server.inspectQueue("inspect-fifo.fifo")!;
    expect(result.messages.ready).toHaveLength(2);
    const bodies = result.messages.ready.map((m) => m.body).sort();
    expect(bodies).toEqual(["fifo-msg-1", "fifo-msg-2"]);
  });
});

describe("Queue inspection - HTTP endpoint", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let baseUrl: string;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false });
    sqs = createSqsClient(server.port);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("GET /_fauxqs/queues returns empty array when no queues exist", async () => {
    const res = await fetch(`${baseUrl}/_fauxqs/queues`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("GET /_fauxqs/queues lists all queues with counts", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "http-inspect-list" }));
    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "hello" }),
    );

    const res = await fetch(`${baseUrl}/_fauxqs/queues`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const entry = body.find((q: { name: string }) => q.name === "http-inspect-list");
    expect(entry).toBeDefined();
    expect(entry.approximateMessageCount).toBe(1);
    expect(entry.approximateInflightCount).toBe(0);
    expect(entry.approximateDelayedCount).toBe(0);
    expect(entry.url).toContain("http-inspect-list");
    expect(entry.arn).toContain("http-inspect-list");
  });

  it("GET /_fauxqs/queues/:name returns 404 for non-existent queue", async () => {
    const res = await fetch(`${baseUrl}/_fauxqs/queues/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("does-not-exist");
  });

  it("GET /_fauxqs/queues/:name returns full queue state", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "http-inspect-detail", Attributes: { VisibilityTimeout: "60" } }),
    );

    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "ready-msg" }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "delayed-msg",
        DelaySeconds: 900,
      }),
    );
    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "msg-b" }),
    );

    // Make one in-flight (takes first available: ready-msg)
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl!, MaxNumberOfMessages: 1 }),
    );

    const res = await fetch(`${baseUrl}/_fauxqs/queues/http-inspect-detail`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.name).toBe("http-inspect-detail");
    expect(body.arn).toContain("http-inspect-detail");
    expect(body.attributes.VisibilityTimeout).toBe("60");
    expect(body.messages.ready).toHaveLength(1);
    expect(body.messages.ready[0].body).toBe("msg-b");
    expect(body.messages.delayed).toHaveLength(1);
    expect(body.messages.delayed[0].body).toBe("delayed-msg");
    expect(body.messages.inflight).toHaveLength(1);
    expect(body.messages.inflight[0].message.body).toBe("ready-msg");
  });

  it("inspection does not consume messages", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "http-inspect-safe" }));
    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "still-here" }),
    );

    // Inspect twice
    await fetch(`${baseUrl}/_fauxqs/queues/http-inspect-safe`);
    await fetch(`${baseUrl}/_fauxqs/queues/http-inspect-safe`);

    // Message should still be receivable
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }),
    );
    expect(recv.Messages).toHaveLength(1);
    expect(recv.Messages![0].Body).toBe("still-here");
  });
});
