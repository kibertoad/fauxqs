import { describe, it, expect, afterEach } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { CreateTopicCommand, SubscribeCommand, PublishCommand } from "@aws-sdk/client-sns";
import { startFauxqs, type FauxqsServer } from "../../src/app.js";
import { SqsStore } from "../../src/sqs/sqsStore.js";
import { mulberry32 } from "../../src/common/prng.js";
import { createSqsClient, createSnsClient } from "../helpers/clients.js";

describe("Standard queue delivery reordering", () => {
  let server: FauxqsServer;

  afterEach(async () => {
    await server?.stop();
  });

  async function sendMany(
    sqs: ReturnType<typeof createSqsClient>,
    queueUrl: string,
    bodies: string[],
  ): Promise<void> {
    for (const body of bodies) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    }
  }

  async function receiveAll(
    sqs: ReturnType<typeof createSqsClient>,
    queueUrl: string,
    count: number,
  ): Promise<string[]> {
    const received: string[] = [];
    while (received.length < count) {
      const res = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }),
      );
      if (!res.Messages?.length) break;
      for (const m of res.Messages) {
        received.push(m.Body!);
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }),
        );
      }
    }
    return received;
  }

  it("propagates a reseed to already-created queues", () => {
    const store = new SqsStore();
    const queue = store.createQueue(
      "q",
      "http://localhost/q",
      "arn:aws:sqs:us-east-1:000000000000:q",
    );
    expect(queue.random).toBe(store.random);

    // Reseeding after the queue exists must reach that queue, not just future ones.
    const seeded = mulberry32(99);
    store.random = seeded;
    expect(queue.random).toBe(seeded);
    expect(queue.random).toBe(store.random);
  });

  it("reorders standard-queue messages (not strict FIFO)", async () => {
    server = await startFauxqs({ port: 0, logger: false, ordering: { seed: 42 } });
    const sqs = createSqsClient(server.port);
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "reorder-q" }));

    const inOrder = Array.from({ length: 10 }, (_, i) => `msg-${i}`);
    await sendMany(sqs, queue.QueueUrl!, inOrder);

    const received = await receiveAll(sqs, queue.QueueUrl!, inOrder.length);

    // Every message is delivered exactly once...
    expect([...received].sort()).toEqual([...inOrder].sort());
    // ...but not in strict send order (seed makes this deterministic).
    expect(received).not.toEqual(inOrder);

    sqs.destroy();
  });

  it("is reproducible for a fixed seed", async () => {
    const inOrder = Array.from({ length: 10 }, (_, i) => `m${i}`);

    server = await startFauxqs({ port: 0, logger: false, ordering: { seed: 12345 } });
    let sqs = createSqsClient(server.port);
    let queue = await sqs.send(new CreateQueueCommand({ QueueName: "seeded-q" }));
    await sendMany(sqs, queue.QueueUrl!, inOrder);
    const firstRun = await receiveAll(sqs, queue.QueueUrl!, inOrder.length);
    sqs.destroy();
    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, ordering: { seed: 12345 } });
    sqs = createSqsClient(server.port);
    queue = await sqs.send(new CreateQueueCommand({ QueueName: "seeded-q" }));
    await sendMany(sqs, queue.QueueUrl!, inOrder);
    const secondRun = await receiveAll(sqs, queue.QueueUrl!, inOrder.length);
    sqs.destroy();

    expect(secondRun).toEqual(firstRun);
  });

  it("does not reorder FIFO queues", async () => {
    server = await startFauxqs({ port: 0, logger: false, ordering: { seed: 42 } });
    const sqs = createSqsClient(server.port);
    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: "ordered-q.fifo",
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    const inOrder = Array.from({ length: 5 }, (_, i) => `fifo-${i}`);
    for (const body of inOrder) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl!,
          MessageBody: body,
          MessageGroupId: "g1",
        }),
      );
    }

    // One message per group per receive; delete to unlock the next.
    const received = await receiveAll(sqs, queue.QueueUrl!, inOrder.length);
    expect(received).toEqual(inOrder);

    sqs.destroy();
  });

  it("reorders end-to-end through SNS standard topic → standard queue", async () => {
    server = await startFauxqs({ port: 0, logger: false, ordering: { seed: 7 } });
    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);

    const queue = await sqs.send(new CreateQueueCommand({ QueueName: "sns-reorder-q" }));
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );
    const topic = await sns.send(new CreateTopicCommand({ Name: "reorder-topic" }));
    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: attrs.Attributes!.QueueArn!,
        Attributes: { RawMessageDelivery: "true" },
      }),
    );

    const inOrder = Array.from({ length: 10 }, (_, i) => `evt-${i}`);
    for (const body of inOrder) {
      await sns.send(new PublishCommand({ TopicArn: topic.TopicArn!, Message: body }));
    }

    const received = await receiveAll(sqs, queue.QueueUrl!, inOrder.length);
    expect([...received].sort()).toEqual([...inOrder].sort());
    expect(received).not.toEqual(inOrder);

    sqs.destroy();
    sns.destroy();
  });
});
