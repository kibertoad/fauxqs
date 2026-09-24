import { describe, it, expect } from "vitest";
import { SqsStore } from "../../src/sqs/sqsStore.ts";
import { SnsStore } from "../../src/sns/snsStore.ts";
import type { PersistenceProvider } from "../../src/persistence/index.ts";

/**
 * A persistence provider whose writes resolve after `delayMs` and succeed unless
 * the method is listed in `failing`. Stands in for an async backend such as
 * PostgreSQL, where every write-through is awaited.
 */
function stubPersistence(opts: { failing?: Set<string>; delayMs?: number } = {}) {
  const calls: string[] = [];
  const failing = opts.failing ?? new Set<string>();
  const provider = new Proxy(
    {},
    {
      get(target: Record<string, unknown>, prop: string) {
        // Not a thenable, or awaiting the provider itself would call into it.
        if (prop === "then") return undefined;
        // A test can wrap a method by assigning over it.
        if (prop in target) return target[prop];
        return async (...args: unknown[]) => {
          calls.push(prop);
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
          if (failing.has(prop)) throw new Error(`${prop} failed`);
          return args;
        };
      },
    },
  ) as PersistenceProvider;
  return { provider, calls, failing };
}

async function queueWith(
  name: string,
  persistence: PersistenceProvider,
  attributes?: Record<string, string>,
) {
  const store = new SqsStore();
  store.persistence = persistence;
  const queue = await store.createQueue(
    name,
    `http://localhost/000000000000/${name}`,
    `arn:aws:sqs:us-east-1:000000000000:${name}`,
    attributes,
  );
  return { store, queue };
}

describe("async persistence failure handling", () => {
  describe("FIFO sends", () => {
    it("enqueues once when concurrent sends share a dedup id", async () => {
      const { provider } = stubPersistence({ delayMs: 5 });
      const { queue } = await queueWith("dedup.fifo", provider, { FifoQueue: "true" });

      const results = await Promise.all(
        [1, 2, 3].map(() =>
          queue.sendFifo(SqsStore.createMessage("body", {}, undefined, "g", "same-id"), "same-id"),
        ),
      );

      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(results.map((r) => r.messageId)).size).toBe(1);
      expect(queue.fifoMessages.get("g")).toHaveLength(1);
    });

    it("enqueues concurrent sends in sequence-number order", async () => {
      const { provider } = stubPersistence({ delayMs: 2 });
      const { queue } = await queueWith("order.fifo", provider, { FifoQueue: "true" });

      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          queue.sendFifo(SqsStore.createMessage(`m${i}`, {}, undefined, "g", `id-${i}`), `id-${i}`),
        ),
      );

      const seqs = queue.fifoMessages.get("g")!.map((m) => m.sequenceNumber!);
      expect(seqs).toEqual([...seqs].sort());
    });

    it("does not reserve the dedup id when the write fails, so a retry goes through", async () => {
      const { provider, failing } = stubPersistence({ failing: new Set(["insertMessage"]) });
      const { queue } = await queueWith("retry.fifo", provider, { FifoQueue: "true" });

      await expect(
        queue.sendFifo(SqsStore.createMessage("body", {}, undefined, "g", "retry"), "retry"),
      ).rejects.toThrow("insertMessage failed");

      failing.clear();
      const retried = await queue.sendFifo(
        SqsStore.createMessage("body", {}, undefined, "g", "retry"),
        "retry",
      );
      expect(retried.duplicate).toBe(false);
      expect(queue.fifoMessages.get("g")).toHaveLength(1);
    });
  });

  it("keeps a message in its source queue when the DLQ write fails", async () => {
    const { provider, failing } = stubPersistence();
    const { store, queue: dlq } = await queueWith("dlq", provider);
    const source = await store.createQueue(
      "src",
      "http://localhost/000000000000/src",
      "arn:aws:sqs:us-east-1:000000000000:src",
      { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 1 }) },
    );
    await source.enqueue(SqsStore.createMessage("poison"));
    const resolve = (arn: string) => store.getQueueByArn(arn);

    const [first] = await source.dequeue(1, 0, resolve);
    await source.changeVisibility(first.ReceiptHandle, 0);

    failing.add("insertMessage");
    await expect(source.dequeue(1, 0, resolve)).rejects.toThrow("insertMessage failed");

    expect(source.messages).toHaveLength(1);
    expect(source.messages[0].approximateReceiveCount).toBe(1);
    expect(source.messages[0].deadLetterSourceArn).toBeUndefined();
    expect(dlq.messages).toHaveLength(0);
  });

  it("leaves a message in flight when making it visible fails", async () => {
    const { provider, failing } = stubPersistence();
    const { queue } = await queueWith("vis", provider);
    await queue.enqueue(SqsStore.createMessage("m"));
    const [received] = await queue.dequeue(1, 30);

    failing.add("updateMessageReady");
    await expect(queue.changeVisibility(received.ReceiptHandle, 0)).rejects.toThrow();

    expect(queue.inflightMessages.has(received.ReceiptHandle)).toBe(true);
    expect(queue.messages).toHaveLength(0);
  });

  it("leaves queue attributes unchanged when the write fails", async () => {
    const { provider, failing } = stubPersistence();
    const { queue } = await queueWith("attrs", provider);
    const before = { ...queue.attributes };

    failing.add("updateQueueAttributes");
    await expect(queue.setAttributes({ VisibilityTimeout: "99" })).rejects.toThrow();

    expect(queue.attributes).toEqual(before);
  });

  it("restores purged messages when the persisted delete fails", async () => {
    const { provider, failing } = stubPersistence();
    const { queue } = await queueWith("purge", provider);
    await queue.enqueue(SqsStore.createMessage("a"));
    await queue.enqueue(SqsStore.createMessage("b"));

    failing.add("deleteQueueMessages");
    await expect(queue.purge()).rejects.toThrow();

    expect(queue.messages.map((m) => m.body).sort()).toEqual(["a", "b"]);
  });

  describe("SNS", () => {
    it("does not expose a topic whose insert failed", async () => {
      const { provider } = stubPersistence({ failing: new Set(["insertTopic"]) });
      const store = new SnsStore();
      store.persistence = provider;

      await expect(store.createTopic("t", undefined, undefined, "us-east-1")).rejects.toThrow();
      expect(store.topics.size).toBe(0);
    });

    it("rolls back a subscription whose topic update failed", async () => {
      const { provider, failing } = stubPersistence();
      const store = new SnsStore();
      store.persistence = provider;
      const topic = await store.createTopic("t", undefined, undefined, "us-east-1");

      failing.add("updateTopicSubscriptionArns");
      await expect(
        store.subscribe(topic.arn, "sqs", "arn:aws:sqs:us-east-1:000000000000:q"),
      ).rejects.toThrow();

      expect(store.subscriptions.size).toBe(0);
      expect(topic.subscriptionArns).toEqual([]);
    });

    it("does not expose a subscription until its topic update is persisted", async () => {
      const { provider } = stubPersistence({ delayMs: 5 });
      const store = new SnsStore();
      store.persistence = provider;
      const topic = await store.createTopic("t", undefined, undefined, "us-east-1");

      const pending = store.subscribe(topic.arn, "sqs", "arn:aws:sqs:us-east-1:000000000000:q");
      await new Promise((r) => setTimeout(r, 7));
      expect(store.subscriptions.size).toBe(0);
      expect(topic.subscriptionArns).toEqual([]);

      await pending;
      expect(store.subscriptions.size).toBe(1);
    });

    it("keeps every arn when subscribes to one topic overlap", async () => {
      const { provider } = stubPersistence({ delayMs: 2 });
      const store = new SnsStore();
      store.persistence = provider;
      const topic = await store.createTopic("t", undefined, undefined, "us-east-1");
      const writes: string[][] = [];
      const update = provider.updateTopicSubscriptionArns.bind(provider);
      provider.updateTopicSubscriptionArns = async (arn: string, arns: string[]) => {
        writes.push([...arns]);
        await update(arn, arns);
      };

      await Promise.all(
        [1, 2, 3].map((i) =>
          store.subscribe(topic.arn, "sqs", `arn:aws:sqs:us-east-1:000000000000:q${i}`),
        ),
      );

      expect(topic.subscriptionArns).toHaveLength(3);
      expect(writes.at(-1)).toEqual(topic.subscriptionArns);
    });

    it("keeps a topic and its subscriptions when the delete fails", async () => {
      const { provider, failing } = stubPersistence();
      const store = new SnsStore();
      store.persistence = provider;
      const topic = await store.createTopic("t", undefined, undefined, "us-east-1");
      await store.subscribe(topic.arn, "sqs", "arn:aws:sqs:us-east-1:000000000000:q");

      failing.add("deleteTopic");
      await expect(store.deleteTopic(topic.arn)).rejects.toThrow();

      expect(store.topics.has(topic.arn)).toBe(true);
      expect(store.subscriptions.size).toBe(1);
    });
  });
});
