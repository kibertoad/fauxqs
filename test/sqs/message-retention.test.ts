import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from "vitest";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  StartMessageMoveTaskCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

const t0 = Date.UTC(2026, 0, 1);

describe("SQS message retention", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
  });

  afterEach(async () => {
    sqs.destroy();
    await server.stop();
    vi.useRealTimers();
  });

  async function createQueue(name: string, attributes: Record<string, string>): Promise<string> {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    );
    return QueueUrl!;
  }

  async function queueArn(queueUrl: string): Promise<string> {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
    );
    return Attributes!.QueueArn!;
  }

  async function send(queueUrl: string, body: string, groupId?: string): Promise<void> {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: groupId ? body : undefined,
      }),
    );
  }

  async function receiveBodies(queueUrl: string): Promise<string[]> {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }),
    );
    return (Messages ?? []).map((message) => message.Body!);
  }

  it("does not deliver a standard-queue message older than MessageRetentionPeriod", async () => {
    const queueUrl = await createQueue("retention-standard", { MessageRetentionPeriod: "60" });
    await send(queueUrl, "old");
    vi.setSystemTime(t0 + 30_000);
    await send(queueUrl, "fresh");

    vi.setSystemTime(t0 + 60_001);

    expect(await receiveBodies(queueUrl)).toEqual(["fresh"]);
    const { messages } = server.inspectQueue("retention-standard")!;
    expect(messages.ready).toEqual([]);
    expect(messages.inflight.map((entry) => entry.message.body)).toEqual(["fresh"]);
  });

  it("keeps a message whose age equals MessageRetentionPeriod", async () => {
    const queueUrl = await createQueue("retention-boundary", { MessageRetentionPeriod: "60" });
    await send(queueUrl, "boundary");

    vi.setSystemTime(t0 + 60_000);

    expect(await receiveBodies(queueUrl)).toEqual(["boundary"]);
  });

  it("does not deliver an expired FIFO message and delivers the next one in its group", async () => {
    const queueUrl = await createQueue("retention.fifo", {
      FifoQueue: "true",
      MessageRetentionPeriod: "60",
    });
    await send(queueUrl, "old", "group-1");
    vi.setSystemTime(t0 + 30_000);
    await send(queueUrl, "new", "group-1");

    vi.setSystemTime(t0 + 60_001);

    expect(await receiveBodies(queueUrl)).toEqual(["new"]);
  });

  it("expires existing messages when SetQueueAttributes lowers MessageRetentionPeriod", async () => {
    const queueUrl = await createQueue("retention-lowered", {});
    await send(queueUrl, "existing");
    vi.setSystemTime(t0 + 120_000);

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: { MessageRetentionPeriod: "60" },
      }),
    );

    expect(await receiveBodies(queueUrl)).toEqual([]);
  });

  it("measures the age of a dead-lettered message from its original send", async () => {
    const dlqUrl = await createQueue("retention-dlq", { MessageRetentionPeriod: "120" });
    const sourceUrl = await createQueue("retention-source", {
      VisibilityTimeout: "0",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: await queueArn(dlqUrl),
        maxReceiveCount: 1,
      }),
    });
    await send(sourceUrl, "dead-lettered");
    expect(await receiveBodies(sourceUrl)).toEqual(["dead-lettered"]);
    vi.setSystemTime(t0 + 100_000);
    expect(await receiveBodies(sourceUrl)).toEqual([]);
    expect(server.inspectQueue("retention-dlq")!.messages.ready).toHaveLength(1);

    vi.setSystemTime(t0 + 120_001);

    expect(await receiveBodies(dlqUrl)).toEqual([]);
  });

  it("does not expire an in-flight message", async () => {
    const queueUrl = await createQueue("retention-inflight", {
      MessageRetentionPeriod: "60",
      VisibilityTimeout: "30",
    });
    await send(queueUrl, "in-flight");
    vi.setSystemTime(t0 + 59_000);
    expect(await receiveBodies(queueUrl)).toEqual(["in-flight"]);

    vi.setSystemTime(t0 + 70_000);

    expect(await receiveBodies(queueUrl)).toEqual([]);
    expect(server.inspectQueue("retention-inflight")!.messages.inflight).toHaveLength(1);
  });

  it.each([
    { kind: "standard", name: "retention-redelivery", attributes: {}, groupId: undefined },
    {
      kind: "FIFO",
      name: "retention-redelivery.fifo",
      attributes: { FifoQueue: "true" },
      groupId: "group-1",
    },
  ])(
    "does not redeliver a $kind message whose visibility timeout ends after its retention",
    async ({ name, attributes, groupId }) => {
      const queueUrl = await createQueue(name, {
        ...attributes,
        MessageRetentionPeriod: "60",
        VisibilityTimeout: "30",
      });
      await send(queueUrl, "redelivered", groupId);
      vi.setSystemTime(t0 + 50_000);
      expect(await receiveBodies(queueUrl)).toEqual(["redelivered"]);

      vi.setSystemTime(t0 + 90_000);

      expect(await receiveBodies(queueUrl)).toEqual([]);
    },
  );

  it("does not redrive an expired dead-lettered message", async () => {
    const dlqUrl = await createQueue("retention-redrive-dlq", { MessageRetentionPeriod: "60" });
    const dlqArn = await queueArn(dlqUrl);
    const sourceUrl = await createQueue("retention-redrive-source", {
      VisibilityTimeout: "0",
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }),
    });
    await send(sourceUrl, "dead-lettered");
    expect(await receiveBodies(sourceUrl)).toEqual(["dead-lettered"]);
    expect(await receiveBodies(sourceUrl)).toEqual([]);
    vi.setSystemTime(t0 + 60_001);

    await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: dlqArn }));

    expect(server.inspectQueue("retention-redrive-source")!.messages.ready).toEqual([]);
  });
});

describe("SQS message retention sweep", () => {
  let server: FauxqsServer;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: t0 });
    server = await startFauxqsTestServer();
  });

  afterEach(async () => {
    await server.stop();
    vi.useRealTimers();
  });

  it("removes expired messages from a queue that nobody receives from", () => {
    server.createQueue("retention-unconsumed", { attributes: { MessageRetentionPeriod: "60" } });
    server.sendMessage("retention-unconsumed", "unconsumed");

    vi.advanceTimersByTime(120_000);

    expect(server.inspectQueue("retention-unconsumed")!.messages.ready).toEqual([]);
  });

  it("removes an expired delayed message from a queue that nobody receives from", () => {
    server.createQueue("retention-unconsumed-delayed", {
      attributes: { MessageRetentionPeriod: "60", DelaySeconds: "30" },
    });
    server.sendMessage("retention-unconsumed-delayed", "delayed");

    vi.advanceTimersByTime(120_000);

    const { messages } = server.inspectQueue("retention-unconsumed-delayed")!;
    expect(messages.delayed).toEqual([]);
    expect(messages.ready).toEqual([]);
  });
});

it("clears the retention sweep timer when the server stops", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const server = await startFauxqsTestServer();

  await server.stop();

  expect(vi.getTimerCount()).toBe(0);
});
