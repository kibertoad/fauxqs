import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqs, type FauxqsServer } from "../../src/app.js";

describe("MessageSpy - waitForMessage timeout", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("rejects when timeout expires and no match arrives", async () => {
    await expect(
      server.spy.waitForMessage({ service: "sqs", queueName: "nonexistent" }, undefined, 100),
    ).rejects.toThrow("waitForMessage timed out after 100ms");
  });

  it("resolves before timeout when message arrives in time", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "timeout-ok" }),
    );

    const promise = server.spy.waitForMessage(
      { service: "sqs", queueName: "timeout-ok" },
      "published",
      5000,
    );

    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "arrived" }),
    );

    const msg = await promise;
    expect(msg.body).toBe("arrived");
  });

  it("resolves retroactively even with timeout set", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "timeout-retro" }),
    );

    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "already-here" }),
    );

    // Message already in buffer — should resolve immediately
    const msg = await server.spy.waitForMessage(
      { service: "sqs", queueName: "timeout-retro", body: "already-here" },
      "published",
      100,
    );
    expect(msg.body).toBe("already-here");
  });
});

describe("MessageSpy - waitForMessageWithId timeout", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("rejects when timeout expires", async () => {
    await expect(
      server.spy.waitForMessageWithId("no-such-id", "consumed", 100),
    ).rejects.toThrow("waitForMessage timed out after 100ms");
  });
});

describe("MessageSpy - waitForMessages", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("collects multiple messages from the buffer retroactively", async () => {
    server.spy.clear();

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "wait-multi-retro" }),
    );

    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "a" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "b" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "c" }));

    const msgs = await server.spy.waitForMessages(
      { service: "sqs", queueName: "wait-multi-retro" },
      { count: 3, status: "published" },
    );

    expect(msgs).toHaveLength(3);
    const bodies = msgs.map((m) => m.body).sort();
    expect(bodies).toEqual(["a", "b", "c"]);
  });

  it("waits for future messages to reach the count", async () => {
    server.spy.clear();

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "wait-multi-future" }),
    );

    // Send 1 message now
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "first" }));

    // Start waiting for 3
    const promise = server.spy.waitForMessages(
      { service: "sqs", queueName: "wait-multi-future" },
      { count: 3, status: "published", timeout: 5000 },
    );

    // Send 2 more
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "second" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "third" }));

    const msgs = await promise;
    expect(msgs).toHaveLength(3);
  });

  it("times out when not enough messages arrive", async () => {
    server.spy.clear();

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "wait-multi-timeout" }),
    );

    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "only-one" }));

    await expect(
      server.spy.waitForMessages(
        { service: "sqs", queueName: "wait-multi-timeout" },
        { count: 5, status: "published", timeout: 100 },
      ),
    ).rejects.toThrow("waitForMessages timed out after 100ms (collected 1/5)");
  });

  it("resolves immediately when buffer has enough messages", async () => {
    server.spy.clear();

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "wait-multi-enough" }),
    );

    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "x" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "y" }));

    // Ask for 2, buffer already has 2
    const msgs = await server.spy.waitForMessages(
      { service: "sqs", queueName: "wait-multi-enough" },
      { count: 2, status: "published" },
    );
    expect(msgs).toHaveLength(2);
  });

  it("works with predicate filter", async () => {
    server.spy.clear();

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "wait-multi-pred" }),
    );

    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "match-a" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "skip" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "match-b" }));

    const msgs = await server.spy.waitForMessages(
      (m) => m.service === "sqs" && m.body.startsWith("match-"),
      { count: 2, status: "published" },
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0].body).toBe("match-a");
    expect(msgs[1].body).toBe("match-b");
  });
});

describe("MessageSpy - expectNoMessage", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("resolves when no matching message arrives within the window", async () => {
    server.spy.clear();

    await server.spy.expectNoMessage(
      { service: "sqs", queueName: "ghost-queue" },
      { within: 100 },
    );
  });

  it("rejects immediately when matching message is already in the buffer", async () => {
    server.spy.clear();

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "expect-no-buffer" }),
    );
    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "oops" }),
    );

    await expect(
      server.spy.expectNoMessage(
        { service: "sqs", queueName: "expect-no-buffer" },
        { status: "published", within: 100 },
      ),
    ).rejects.toThrow("matching message already in buffer");
  });

  it("rejects when matching message arrives during the wait window", async () => {
    server.spy.clear();

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "expect-no-arrives" }),
    );

    const promise = server.spy.expectNoMessage(
      { service: "sqs", queueName: "expect-no-arrives" },
      { status: "published", within: 2000 },
    );

    // Attach rejection handler before triggering the rejection to avoid unhandled rejection warning
    const assertion = expect(promise).rejects.toThrow("matching message arrived during wait");

    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "surprise" }),
    );

    await assertion;
  });

  it("uses default 200ms window when within is not specified", async () => {
    server.spy.clear();

    const start = Date.now();
    await server.spy.expectNoMessage({ service: "sqs", queueName: "default-window" });
    const elapsed = Date.now() - start;

    // Should take approximately 200ms (with some tolerance)
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(500);
  });

  it("works with status filter", async () => {
    server.spy.clear();

    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "expect-no-status" }),
    );

    // Send a message (published status)
    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "exists" }),
    );

    // Expect no "consumed" message — should pass since we only published
    await server.spy.expectNoMessage(
      { service: "sqs", queueName: "expect-no-status" },
      { status: "consumed", within: 100 },
    );
  });

  it("resolves when spy is cleared during the window", async () => {
    const promise = server.spy.expectNoMessage(
      { service: "sqs", queueName: "cleared-during-wait" },
      { within: 5000 },
    );

    await new Promise((r) => setTimeout(r, 50));
    server.spy.clear();

    await promise;
  });
});
