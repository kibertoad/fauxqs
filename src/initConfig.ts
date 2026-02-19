import { readFileSync } from "node:fs";
import { sqsQueueArn } from "./common/arnHelper.ts";
import { snsTopicArn } from "./common/arnHelper.ts";
import { DEFAULT_ACCOUNT_ID } from "./common/types.ts";
import type { SqsStore } from "./sqs/sqsStore.ts";
import type { SnsStore } from "./sns/snsStore.ts";
import type { S3Store } from "./s3/s3Store.ts";

export interface FauxqsInitConfig {
  queues?: Array<{
    name: string;
    attributes?: Record<string, string>;
    tags?: Record<string, string>;
  }>;
  topics?: Array<{
    name: string;
    attributes?: Record<string, string>;
    tags?: Record<string, string>;
  }>;
  subscriptions?: Array<{
    topic: string;
    queue: string;
    attributes?: Record<string, string>;
  }>;
  buckets?: string[];
}

export function loadInitConfig(path: string): FauxqsInitConfig {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as FauxqsInitConfig;
}

export function applyInitConfig(
  config: FauxqsInitConfig,
  sqsStore: SqsStore,
  snsStore: SnsStore,
  s3Store: S3Store,
  context: { host?: string; port: number; region: string },
): void {
  const { host, port, region } = context;

  // Create queues first (subscriptions depend on queue ARNs)
  if (config.queues) {
    for (const q of config.queues) {
      const arn = sqsQueueArn(q.name, region);
      let url: string;
      if (host) {
        url = `http://sqs.${region}.${host}:${port}/${DEFAULT_ACCOUNT_ID}/${q.name}`;
      } else {
        url = `http://127.0.0.1:${port}/${DEFAULT_ACCOUNT_ID}/${q.name}`;
      }
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
