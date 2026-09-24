import type { SqsStore, SqsQueue } from "../sqs/sqsStore.ts";
import type { SqsMessage } from "../sqs/sqsTypes.ts";
import type { SnsStore } from "../sns/snsStore.ts";
import type { SnsTopic, SnsSubscription } from "../sns/snsTypes.ts";
import type { S3Store } from "../s3/s3Store.ts";
import type { S3PersistenceProvider } from "../s3/s3Persistence.ts";

/**
 * Full persistence provider interface covering SQS, SNS, and S3.
 * All methods return `void | Promise<void>` (or `Buffer | Promise<Buffer>` for reads)
 * so that both synchronous (SQLite) and asynchronous (PostgreSQL) backends can implement it.
 */
export interface PersistenceProvider extends S3PersistenceProvider {
  // ── SQS Queue write-through ──
  insertQueue(queue: SqsQueue): void | Promise<void>;
  deleteQueue(name: string): void | Promise<void>;
  updateQueueAttributes(
    name: string,
    attributes: Record<string, string>,
    lastModified: number,
  ): void | Promise<void>;
  updateQueueSequenceCounter(name: string, counter: number): void | Promise<void>;

  // ── SQS Message write-through ──
  insertMessage(queueName: string, msg: SqsMessage): void | Promise<void>;
  deleteMessage(messageId: string): void | Promise<void>;
  updateMessageInflight(
    messageId: string,
    receiptHandle: string,
    visibilityDeadline: number,
    receiveCount: number,
    firstReceiveTimestamp: number | undefined,
  ): void | Promise<void>;
  updateMessageReady(messageId: string): void | Promise<void>;
  deleteQueueMessages(queueName: string): void | Promise<void>;
  deleteAllMessages(): void | Promise<void>;

  // ── SNS Topic write-through ──
  insertTopic(topic: SnsTopic): void | Promise<void>;
  deleteTopic(arn: string): void | Promise<void>;
  updateTopicAttributes(arn: string, attributes: Record<string, string>): void | Promise<void>;
  updateTopicSubscriptionArns(arn: string, arns: string[]): void | Promise<void>;

  // ── SNS Subscription write-through ──
  insertSubscription(sub: SnsSubscription): void | Promise<void>;
  deleteSubscription(arn: string): void | Promise<void>;
  updateSubscriptionAttributes(
    arn: string,
    attributes: Record<string, string>,
  ): void | Promise<void>;

  // ── Bulk operations ──
  clearMessagesAndObjects(): void | Promise<void>;
  purgeAll(): void | Promise<void>;

  // ── Load on startup ──
  load(sqsStore: SqsStore, snsStore: SnsStore, s3Store: S3Store): void | Promise<void>;
  loadSqsAndSns(sqsStore: SqsStore, snsStore: SnsStore): void | Promise<void>;

  // ── Lifecycle ──
  close(): void | Promise<void>;
}
