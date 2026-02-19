import { readFileSync } from "node:fs";
import * as v from "valibot";
import { sqsQueueArn } from "./common/arnHelper.ts";
import { snsTopicArn } from "./common/arnHelper.ts";

import type { SqsStore } from "./sqs/sqsStore.ts";
import type { SnsStore } from "./sns/snsStore.ts";
import type { S3Store } from "./s3/s3Store.ts";

const StringRecordSchema = v.record(v.string(), v.string());

const QueueSchema = v.object({
  name: v.string(),
  attributes: v.optional(StringRecordSchema),
  tags: v.optional(StringRecordSchema),
});

const TopicSchema = v.object({
  name: v.string(),
  attributes: v.optional(StringRecordSchema),
  tags: v.optional(StringRecordSchema),
});

const SubscriptionSchema = v.object({
  topic: v.string(),
  queue: v.string(),
  attributes: v.optional(StringRecordSchema),
});

const InitConfigSchema = v.object({
  queues: v.optional(v.array(QueueSchema)),
  topics: v.optional(v.array(TopicSchema)),
  subscriptions: v.optional(v.array(SubscriptionSchema)),
  buckets: v.optional(v.array(v.string())),
});

export type FauxqsInitConfig = v.InferOutput<typeof InitConfigSchema>;

export function validateInitConfig(data: unknown): FauxqsInitConfig {
  return v.parse(InitConfigSchema, data);
}

export function loadInitConfig(path: string): FauxqsInitConfig {
  const content = readFileSync(path, "utf-8");
  return validateInitConfig(JSON.parse(content));
}

export function applyInitConfig(
  config: FauxqsInitConfig,
  sqsStore: SqsStore,
  snsStore: SnsStore,
  s3Store: S3Store,
  context: { port: number; region: string },
): void {
  const { port, region } = context;

  // Create queues first (subscriptions depend on queue ARNs)
  if (config.queues) {
    const defaultHost = `127.0.0.1:${port}`;
    for (const q of config.queues) {
      const arn = sqsQueueArn(q.name, region);
      const url = sqsStore.buildQueueUrl(q.name, String(port), defaultHost, region);
      sqsStore.createQueue(q.name, url, arn, q.attributes, q.tags);
    }
  }

  // Create topics next
  if (config.topics) {
    for (const t of config.topics) {
      snsStore.createTopic(t.name, t.attributes, t.tags);
    }
  }

  // Create subscriptions last (depends on both topic ARN and queue ARN)
  if (config.subscriptions) {
    for (const s of config.subscriptions) {
      const topicArn = snsTopicArn(s.topic, region);
      const queueArn = sqsQueueArn(s.queue, region);
      snsStore.subscribe(topicArn, "sqs", queueArn, s.attributes);
    }
  }

  // Create buckets (independent)
  if (config.buckets) {
    for (const name of config.buckets) {
      s3Store.createBucket(name);
    }
  }
}
