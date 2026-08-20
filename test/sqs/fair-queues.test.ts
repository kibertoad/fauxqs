import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { startFauxqs, type FauxqsServer } from "../../src/app.js";
import { createSqsClient } from "../helpers/clients.js";

describe("SQS fair queues (MessageGroupId on standard queues)", () => {
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

  it("accepts MessageGroupId on SendMessage and returns it via ReceiveMessage", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-send" }));

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "tenant message",
        MessageGroupId: "tenant-1",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("tenant message");
    expect(received.Messages![0].Attributes?.MessageGroupId).toBe("tenant-1");
  });

  it("returns MessageGroupId when MessageSystemAttributeNames includes All", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-all-attrs" }));

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "all attrs",
        MessageGroupId: "tenant-2",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageSystemAttributeNames: ["All"],
      }),
    );

    expect(received.Messages![0].Attributes?.MessageGroupId).toBe("tenant-2");
  });

  it("omits MessageGroupId for messages sent without one", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-ungrouped" }));

    await sqs.send(
      new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "no group" }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );

    expect(received.Messages![0].Attributes?.MessageGroupId).toBeUndefined();
  });

  it("still honors per-message DelaySeconds alongside MessageGroupId", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-delay" }));

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "delayed grouped",
        MessageGroupId: "tenant-3",
        DelaySeconds: 1,
      }),
    );

    const immediate = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl! }));
    expect(immediate.Messages).toBeUndefined();

    const later = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.QueueUrl!,
        WaitTimeSeconds: 3,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    expect(later.Messages![0].Attributes?.MessageGroupId).toBe("tenant-3");
  });

  it("accepts per-entry MessageGroupId on SendMessageBatch", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-batch" }));

    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queue.QueueUrl!,
        Entries: [
          { Id: "a", MessageBody: "for tenant a", MessageGroupId: "tenant-a" },
          { Id: "b", MessageBody: "for tenant b", MessageGroupId: "tenant-b" },
          { Id: "c", MessageBody: "ungrouped" },
        ],
      }),
    );
    expect(result.Successful).toHaveLength(3);

    const groupsByBody = new Map<string, string | undefined>();
    while (groupsByBody.size < 3) {
      const received = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MaxNumberOfMessages: 10,
          MessageSystemAttributeNames: ["MessageGroupId"],
        }),
      );
      for (const msg of received.Messages ?? []) {
        groupsByBody.set(msg.Body!, msg.Attributes?.MessageGroupId);
      }
    }

    expect(groupsByBody.get("for tenant a")).toBe("tenant-a");
    expect(groupsByBody.get("for tenant b")).toBe("tenant-b");
    expect(groupsByBody.get("ungrouped")).toBeUndefined();
  });

  it("rejects a MessageGroupId longer than 128 characters on a standard queue", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-too-long" }));

    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MessageBody: "body",
          MessageGroupId: "g".repeat(129),
        }),
      ),
    ).rejects.toThrow("MessageGroupId can only include alphanumeric and punctuation characters");
  });

  it("rejects a MessageGroupId with disallowed characters on a standard queue", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-bad-chars" }));

    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MessageBody: "body",
          MessageGroupId: "has spaces",
        }),
      ),
    ).rejects.toThrow("MessageGroupId can only include alphanumeric and punctuation characters");
  });

  it("accepts all punctuation characters AWS allows", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-punctuation" }));

    const result = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "body",
        MessageGroupId: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
      }),
    );
    expect(result.MessageId).toBeDefined();
  });

  it("rejects a malformed MessageGroupId on a FIFO queue too", async () => {
    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: "fair-fifo-validation.fifo",
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MessageBody: "body",
          MessageGroupId: "g".repeat(129),
        }),
      ),
    ).rejects.toThrow("MessageGroupId can only include alphanumeric and punctuation characters");
  });

  it("fails only the offending entry in SendMessageBatch", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-batch-partial" }));

    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queue.QueueUrl!,
        Entries: [
          { Id: "ok", MessageBody: "fine", MessageGroupId: "tenant-ok" },
          { Id: "bad", MessageBody: "broken", MessageGroupId: "not valid" },
        ],
      }),
    );

    expect(result.Successful).toHaveLength(1);
    expect(result.Successful![0].Id).toBe("ok");
    expect(result.Failed).toHaveLength(1);
    expect(result.Failed![0].Id).toBe("bad");
    expect(result.Failed![0].Code).toBe("InvalidParameterValue");
    expect(result.Failed![0].SenderFault).toBe(true);
  });

  it("exposes messageGroupId in spy events and queue inspection", async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-spy" }));

    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "spied",
        MessageGroupId: "tenant-spy",
      }),
    );

    const spied = server.spy.checkForMessage(
      (m) => "messageId" in m && m.messageId === sent.MessageId,
      "published",
    );
    expect(spied).toBeDefined();
    expect((spied as { messageGroupId?: string }).messageGroupId).toBe("tenant-spy");

    const inspected = server.inspectQueue("fair-spy");
    expect(inspected?.messages.ready).toHaveLength(1);
    expect(inspected?.messages.ready[0].messageGroupId).toBe("tenant-spy");
  });
});

describe("Fair delivery across message groups", () => {
  let server: FauxqsServer;

  afterEach(async () => {
    await server?.stop();
  });

  it("does not let a backlogged group starve a quiet group", async () => {
    server = await startFauxqs({ port: 0, logger: false, ordering: { seed: 42 } });
    const sqs = createSqsClient(server.port);
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-delivery" }));

    // A noisy tenant backlogs the queue, then a quiet tenant sends one message.
    for (let i = 0; i < 30; i++) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MessageBody: `noisy-${i}`,
          MessageGroupId: "noisy",
        }),
      );
    }
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl!,
        MessageBody: "quiet-0",
        MessageGroupId: "quiet",
      }),
    );

    // Group-fair selection gives the quiet group a 50% chance per pick, so its
    // message surfaces in the first batch of 10 (deterministic under the seed).
    // Plain uniform-over-messages selection would leave it buried with ~20% odds.
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl!, MaxNumberOfMessages: 10 }),
    );
    const bodies = (received.Messages ?? []).map((m) => m.Body!);
    expect(bodies).toContain("quiet-0");

    sqs.destroy();
  });

  it("keeps seeded ordering reproducible for grouped messages", async () => {
    const runOnce = async (): Promise<string[]> => {
      const srv = await startFauxqs({ port: 0, logger: false, ordering: { seed: 7 } });
      const sqs = createSqsClient(srv.port);
      const queue = await sqs.send(new CreateQueueCommand({ QueueName: "fair-seeded" }));
      for (let i = 0; i < 10; i++) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queue.QueueUrl!,
            MessageBody: `m${i}`,
            MessageGroupId: i % 2 === 0 ? "even" : "odd",
          }),
        );
      }

      const received: string[] = [];
      while (received.length < 10) {
        const res = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: queue.QueueUrl!, MaxNumberOfMessages: 10 }),
        );
        if (!res.Messages?.length) break;
        for (const m of res.Messages) {
          received.push(m.Body!);
          await sqs.send(
            new DeleteMessageCommand({ QueueUrl: queue.QueueUrl!, ReceiptHandle: m.ReceiptHandle! }),
          );
        }
      }
      sqs.destroy();
      await srv.stop();
      return received;
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(second).toEqual(first);
    expect([...first].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`).sort());
  });
});
