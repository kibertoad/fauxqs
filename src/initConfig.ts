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
  region: v.optional(v.string()),
  attributes: v.optional(StringRecordSchema),
  tags: v.optional(StringRecordSchema),
});

const TopicSchema = v.object({
  name: v.string(),
  region: v.optional(v.string()),
  attributes: v.optional(StringRecordSchema),
  tags: v.optional(StringRecordSchema),
});

const SubscriptionSchema = v.object({
  topic: v.string(),
  queue: v.string(),
  region: v.optional(v.string()),
  attributes: v.optional(StringRecordSchema),
});

const BucketSchema = v.union([
  v.string(),
  v.object({
    name: v.string(),
    type: v.optional(v.picklist(["general-purpose", "directory"])),
  }),
]);

const InitConfigSchema = v.object({
  region: v.optional(v.string()),
  queues: v.optional(v.array(QueueSchema)),
  topics: v.optional(v.array(TopicSchema)),
  subscriptions: v.optional(v.array(SubscriptionSchema)),
  buckets: v.optional(v.array(BucketSchema)),
});

export type FauxqsInitConfig = v.InferOutput<typeof InitConfigSchema>;

export interface SetupQueueResult {
  name: string;
  url: string;
  arn: string;
  created: boolean;
}
export interface SetupTopicResult {
  name: string;
  arn: string;
  created: boolean;
}
export interface SetupSubscriptionResult {
  topicName: string;
  queueName: string;
  subscriptionArn: string;
  created: boolean;
}
export interface SetupBucketResult {
  name: string;
  created: boolean;
}
export interface SetupResult {
  queues: SetupQueueResult[];
  topics: SetupTopicResult[];
  subscriptions: SetupSubscriptionResult[];
  buckets: SetupBucketResult[];
}

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
): SetupResult {
  const { port } = context;
  // Top-level init.json region overrides the context default, but individual
  // resources can further override with their own region field.
  const defaultRegion = config.region ?? context.region;

  // Set store default regions. Used as fallback when the request's
  // Authorization header does not contain a region (e.g. unsigned requests).
  sqsStore.region = defaultRegion;
  snsStore.region = defaultRegion;

  const queueResults: SetupQueueResult[] = [];
  const topicResults: SetupTopicResult[] = [];
  const subscriptionResults: SetupSubscriptionResult[] = [];
  const bucketResults: SetupBucketResult[] = [];

  // Create queues first (subscriptions depend on queue ARNs)
  if (config.queues) {
    const defaultHost = `127.0.0.1:${port}`;
    for (const q of config.queues) {
      const region = q.region ?? defaultRegion;
      const arn = sqsQueueArn(q.name, region);
      const url = sqsStore.buildQueueUrl(q.name, String(port), defaultHost, region);
      if (sqsStore.getQueueByName(q.name)) {
        const existing = sqsStore.getQueueByName(q.name)!;
        queueResults.push({ name: q.name, url: existing.url, arn: existing.arn, created: false });
        continue;
      }
      sqsStore.createQueue(q.name, url, arn, q.attributes, q.tags);
      queueResults.push({ name: q.name, url, arn, created: true });
    }
  }

  // Create topics next
  if (config.topics) {
    for (const t of config.topics) {
      const region = t.region ?? defaultRegion;
      const arn = snsTopicArn(t.name, region);
      const existed = !!snsStore.getTopic(arn);
      snsStore.createTopic(t.name, t.attributes, t.tags, region);
      topicResults.push({ name: t.name, arn, created: !existed });
    }
  }

  // Create subscriptions last (depends on both topic ARN and queue ARN)
  if (config.subscriptions) {
    for (const s of config.subscriptions) {
      const region = s.region ?? defaultRegion;
      const topicArn = snsTopicArn(s.topic, region);
      const queueArn = sqsQueueArn(s.queue, region);
      const topic = snsStore.getTopic(topicArn);
      if (!topic) {
        throw new Error(
          `Init config: cannot create subscription — topic "${s.topic}" does not exist`,
        );
      }
      const countBefore = topic.subscriptionArns.length;
      const sub = snsStore.subscribe(topicArn, "sqs", queueArn, s.attributes);
      if (!sub) {
        throw new Error(
          `Init config: cannot create subscription — topic "${s.topic}" does not exist`,
        );
      }
      const created = topic.subscriptionArns.length > countBefore;
      subscriptionResults.push({
        topicName: s.topic,
        queueName: s.queue,
        subscriptionArn: sub.arn,
        created,
      });
    }
  }

  // Create buckets (independent)
  if (config.buckets) {
    for (const entry of config.buckets) {
      const name = typeof entry === "string" ? entry : entry.name;
      const existed = s3Store.hasBucket(name);
      if (typeof entry === "string") {
        s3Store.createBucket(entry);
      } else {
        s3Store.createBucket(entry.name, entry.type);
      }
      bucketResults.push({ name, created: !existed });
    }
  }

  return {
    queues: queueResults,
    topics: topicResults,
    subscriptions: subscriptionResults,
    buckets: bucketResults,
  };
}
