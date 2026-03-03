import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqsStore, SqsQueue } from "./sqs/sqsStore.ts";
import type { SqsMessage } from "./sqs/sqsTypes.ts";
import type { SnsStore } from "./sns/snsStore.ts";
import type { SnsTopic, SnsSubscription } from "./sns/snsTypes.ts";
import type { S3Store, BucketType } from "./s3/s3Store.ts";
import type { S3Object, MultipartUpload, MultipartPart } from "./s3/s3Types.ts";
import type { ChecksumAlgorithm } from "./s3/s3Types.ts";
import type { S3PersistenceProvider } from "./s3/s3Persistence.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sqs_queues (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  arn TEXT NOT NULL,
  attributes TEXT NOT NULL,
  tags TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  last_modified_timestamp INTEGER NOT NULL,
  sequence_counter INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sqs_messages (
  message_id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL REFERENCES sqs_queues(name) ON DELETE CASCADE,
  body TEXT NOT NULL,
  md5_of_body TEXT NOT NULL,
  message_attributes TEXT NOT NULL,
  md5_of_message_attributes TEXT NOT NULL,
  sent_timestamp INTEGER NOT NULL,
  approximate_receive_count INTEGER NOT NULL DEFAULT 0,
  approximate_first_receive_timestamp INTEGER,
  delay_until INTEGER,
  message_group_id TEXT,
  message_deduplication_id TEXT,
  sequence_number TEXT,
  receipt_handle TEXT,
  visibility_deadline INTEGER
);

CREATE TABLE IF NOT EXISTS sns_topics (
  arn TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  attributes TEXT NOT NULL,
  tags TEXT NOT NULL,
  subscription_arns TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sns_subscriptions (
  arn TEXT PRIMARY KEY,
  topic_arn TEXT NOT NULL,
  protocol TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  attributes TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS s3_buckets (
  name TEXT PRIMARY KEY,
  creation_date TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'general-purpose'
);

CREATE TABLE IF NOT EXISTS s3_objects (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  body BLOB NOT NULL,
  content_type TEXT NOT NULL,
  content_length INTEGER NOT NULL,
  etag TEXT NOT NULL,
  last_modified TEXT NOT NULL,
  metadata TEXT NOT NULL,
  content_language TEXT,
  content_disposition TEXT,
  cache_control TEXT,
  content_encoding TEXT,
  parts TEXT,
  checksum_algorithm TEXT,
  checksum_value TEXT,
  checksum_type TEXT,
  part_checksums TEXT,
  PRIMARY KEY (bucket, key)
);

CREATE TABLE IF NOT EXISTS s3_multipart_uploads (
  upload_id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  metadata TEXT NOT NULL,
  initiated TEXT NOT NULL,
  content_language TEXT,
  content_disposition TEXT,
  cache_control TEXT,
  content_encoding TEXT,
  checksum_algorithm TEXT
);

CREATE TABLE IF NOT EXISTS s3_multipart_parts (
  upload_id TEXT NOT NULL REFERENCES s3_multipart_uploads(upload_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  body BLOB NOT NULL,
  etag TEXT NOT NULL,
  last_modified TEXT NOT NULL,
  checksum_value TEXT,
  PRIMARY KEY (upload_id, part_number)
);
`;

interface PreparedStatements {
  insertQueue: StatementSync;
  deleteQueue: StatementSync;
  updateQueueAttributes: StatementSync;
  updateQueueSequenceCounter: StatementSync;
  loadQueues: StatementSync;
  insertMessage: StatementSync;
  deleteMessage: StatementSync;
  updateMessageInflight: StatementSync;
  deleteQueueMessages: StatementSync;
  loadMessages: StatementSync;
  deleteAllMessages: StatementSync;
  insertTopic: StatementSync;
  deleteTopic: StatementSync;
  updateTopicAttributes: StatementSync;
  updateTopicSubscriptionArns: StatementSync;
  loadTopics: StatementSync;
  insertSubscription: StatementSync;
  deleteSubscription: StatementSync;
  updateSubscriptionAttributes: StatementSync;
  loadSubscriptions: StatementSync;
  insertBucket: StatementSync;
  deleteBucket: StatementSync;
  loadBuckets: StatementSync;
  upsertObject: StatementSync;
  deleteObject: StatementSync;
  deleteObjectsByBucket: StatementSync;
  deleteAllObjects: StatementSync;
  loadObjectsMeta: StatementSync;
  insertMultipartUpload: StatementSync;
  deleteMultipartUpload: StatementSync;
  loadMultipartUploads: StatementSync;
  upsertMultipartPart: StatementSync;
  deleteMultipartParts: StatementSync;
  loadMultipartParts: StatementSync;
  deleteAllMultipartParts: StatementSync;
  deleteAllMultipartUploads: StatementSync;
  readBody: StatementSync;
}

export class PersistenceManager implements S3PersistenceProvider {
  private db: DatabaseSync;
  private stmts: PreparedStatements;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "fauxqs.db");
    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.stmts = this.prepareStatements();
  }

  private prepareStatements(): PreparedStatements {
    return {
      insertQueue: this.db.prepare(`
        INSERT OR REPLACE INTO sqs_queues (name, url, arn, attributes, tags, created_timestamp, last_modified_timestamp, sequence_counter)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      deleteQueue: this.db.prepare("DELETE FROM sqs_queues WHERE name = ?"),
      updateQueueAttributes: this.db.prepare(
        "UPDATE sqs_queues SET attributes = ?, last_modified_timestamp = ? WHERE name = ?",
      ),
      updateQueueSequenceCounter: this.db.prepare(
        "UPDATE sqs_queues SET sequence_counter = ? WHERE name = ?",
      ),
      loadQueues: this.db.prepare("SELECT * FROM sqs_queues"),
      insertMessage: this.db.prepare(`
        INSERT OR REPLACE INTO sqs_messages (
          message_id, queue_name, body, md5_of_body, message_attributes, md5_of_message_attributes,
          sent_timestamp, approximate_receive_count, approximate_first_receive_timestamp,
          delay_until, message_group_id, message_deduplication_id, sequence_number,
          receipt_handle, visibility_deadline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      deleteMessage: this.db.prepare("DELETE FROM sqs_messages WHERE message_id = ?"),
      updateMessageInflight: this.db.prepare(`
        UPDATE sqs_messages SET receipt_handle = ?, visibility_deadline = ?, approximate_receive_count = ?, approximate_first_receive_timestamp = ?
        WHERE message_id = ?
      `),
      deleteQueueMessages: this.db.prepare("DELETE FROM sqs_messages WHERE queue_name = ?"),
      loadMessages: this.db.prepare("SELECT * FROM sqs_messages WHERE queue_name = ?"),
      deleteAllMessages: this.db.prepare("DELETE FROM sqs_messages"),
      insertTopic: this.db.prepare(`
        INSERT OR REPLACE INTO sns_topics (arn, name, attributes, tags, subscription_arns)
        VALUES (?, ?, ?, ?, ?)
      `),
      deleteTopic: this.db.prepare("DELETE FROM sns_topics WHERE arn = ?"),
      updateTopicAttributes: this.db.prepare("UPDATE sns_topics SET attributes = ? WHERE arn = ?"),
      updateTopicSubscriptionArns: this.db.prepare(
        "UPDATE sns_topics SET subscription_arns = ? WHERE arn = ?",
      ),
      loadTopics: this.db.prepare("SELECT * FROM sns_topics"),
      insertSubscription: this.db.prepare(`
        INSERT OR REPLACE INTO sns_subscriptions (arn, topic_arn, protocol, endpoint, confirmed, attributes)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      deleteSubscription: this.db.prepare("DELETE FROM sns_subscriptions WHERE arn = ?"),
      updateSubscriptionAttributes: this.db.prepare(
        "UPDATE sns_subscriptions SET attributes = ? WHERE arn = ?",
      ),
      loadSubscriptions: this.db.prepare("SELECT * FROM sns_subscriptions"),
      insertBucket: this.db.prepare(
        "INSERT OR REPLACE INTO s3_buckets (name, creation_date, type) VALUES (?, ?, ?)",
      ),
      deleteBucket: this.db.prepare("DELETE FROM s3_buckets WHERE name = ?"),
      loadBuckets: this.db.prepare("SELECT * FROM s3_buckets"),
      upsertObject: this.db.prepare(`
        INSERT OR REPLACE INTO s3_objects (
          bucket, key, body, content_type, content_length, etag, last_modified, metadata,
          content_language, content_disposition, cache_control, content_encoding,
          parts, checksum_algorithm, checksum_value, checksum_type, part_checksums
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      deleteObject: this.db.prepare("DELETE FROM s3_objects WHERE bucket = ? AND key = ?"),
      deleteObjectsByBucket: this.db.prepare("DELETE FROM s3_objects WHERE bucket = ?"),
      deleteAllObjects: this.db.prepare("DELETE FROM s3_objects"),
      loadObjectsMeta: this.db.prepare(
        "SELECT bucket, key, content_type, content_length, etag, last_modified, metadata, content_language, content_disposition, cache_control, content_encoding, parts, checksum_algorithm, checksum_value, checksum_type, part_checksums FROM s3_objects",
      ),
      insertMultipartUpload: this.db.prepare(`
        INSERT OR REPLACE INTO s3_multipart_uploads (
          upload_id, bucket, key, content_type, metadata, initiated,
          content_language, content_disposition, cache_control, content_encoding, checksum_algorithm
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      deleteMultipartUpload: this.db.prepare(
        "DELETE FROM s3_multipart_uploads WHERE upload_id = ?",
      ),
      loadMultipartUploads: this.db.prepare("SELECT * FROM s3_multipart_uploads"),
      upsertMultipartPart: this.db.prepare(`
        INSERT OR REPLACE INTO s3_multipart_parts (upload_id, part_number, body, etag, last_modified, checksum_value)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      deleteMultipartParts: this.db.prepare("DELETE FROM s3_multipart_parts WHERE upload_id = ?"),
      loadMultipartParts: this.db.prepare("SELECT * FROM s3_multipart_parts WHERE upload_id = ?"),
      deleteAllMultipartParts: this.db.prepare("DELETE FROM s3_multipart_parts"),
      deleteAllMultipartUploads: this.db.prepare("DELETE FROM s3_multipart_uploads"),
      readBody: this.db.prepare("SELECT body FROM s3_objects WHERE bucket = ? AND key = ?"),
    };
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── SQS Queue write-through ──

  insertQueue(queue: SqsQueue): void {
    this.stmts.insertQueue.run(
      queue.name,
      queue.url,
      queue.arn,
      JSON.stringify(queue.attributes),
      JSON.stringify(Object.fromEntries(queue.tags)),
      queue.createdTimestamp,
      queue.lastModifiedTimestamp,
      queue.sequenceCounter,
    );
  }

  deleteQueue(name: string): void {
    this.stmts.deleteQueue.run(name);
  }

  updateQueueAttributes(
    name: string,
    attributes: Record<string, string>,
    lastModified: number,
  ): void {
    this.stmts.updateQueueAttributes.run(JSON.stringify(attributes), lastModified, name);
  }

  updateQueueSequenceCounter(name: string, counter: number): void {
    this.stmts.updateQueueSequenceCounter.run(counter, name);
  }

  // ── SQS Message write-through ──

  insertMessage(queueName: string, msg: SqsMessage): void {
    this.stmts.insertMessage.run(
      msg.messageId,
      queueName,
      msg.body,
      msg.md5OfBody,
      JSON.stringify(msg.messageAttributes),
      msg.md5OfMessageAttributes,
      msg.sentTimestamp,
      msg.approximateReceiveCount,
      msg.approximateFirstReceiveTimestamp ?? null,
      msg.delayUntil ?? null,
      msg.messageGroupId ?? null,
      msg.messageDeduplicationId ?? null,
      msg.sequenceNumber ?? null,
      null,
      null,
    );
  }

  deleteMessage(messageId: string): void {
    this.stmts.deleteMessage.run(messageId);
  }

  updateMessageInflight(
    messageId: string,
    receiptHandle: string,
    visibilityDeadline: number,
    receiveCount: number,
    firstReceiveTimestamp: number | undefined,
  ): void {
    this.stmts.updateMessageInflight.run(
      receiptHandle,
      visibilityDeadline,
      receiveCount,
      firstReceiveTimestamp ?? null,
      messageId,
    );
  }

  updateMessageReady(messageId: string): void {
    this.stmts.updateMessageInflight.run(null, null, null, null, messageId);
  }

  deleteQueueMessages(queueName: string): void {
    this.stmts.deleteQueueMessages.run(queueName);
  }

  deleteAllMessages(): void {
    this.stmts.deleteAllMessages.run();
  }

  // ── SNS Topic write-through ──

  insertTopic(topic: SnsTopic): void {
    this.stmts.insertTopic.run(
      topic.arn,
      topic.name,
      JSON.stringify(topic.attributes),
      JSON.stringify(Object.fromEntries(topic.tags)),
      JSON.stringify(topic.subscriptionArns),
    );
  }

  deleteTopic(arn: string): void {
    this.stmts.deleteTopic.run(arn);
  }

  updateTopicAttributes(arn: string, attributes: Record<string, string>): void {
    this.stmts.updateTopicAttributes.run(JSON.stringify(attributes), arn);
  }

  updateTopicSubscriptionArns(arn: string, arns: string[]): void {
    this.stmts.updateTopicSubscriptionArns.run(JSON.stringify(arns), arn);
  }

  // ── SNS Subscription write-through ──

  insertSubscription(sub: SnsSubscription): void {
    this.stmts.insertSubscription.run(
      sub.arn,
      sub.topicArn,
      sub.protocol,
      sub.endpoint,
      sub.confirmed ? 1 : 0,
      JSON.stringify(sub.attributes),
    );
  }

  deleteSubscription(arn: string): void {
    this.stmts.deleteSubscription.run(arn);
  }

  updateSubscriptionAttributes(arn: string, attributes: Record<string, string>): void {
    this.stmts.updateSubscriptionAttributes.run(JSON.stringify(attributes), arn);
  }

  // ── S3 Bucket write-through ──

  insertBucket(name: string, creationDate: Date, type: BucketType): void {
    this.stmts.insertBucket.run(name, creationDate.toISOString(), type);
  }

  deleteBucket(name: string): void {
    this.stmts.deleteBucket.run(name);
  }

  // ── S3 Object write-through ──

  upsertObject(bucket: string, obj: S3Object): void {
    this.stmts.upsertObject.run(
      bucket,
      obj.key,
      obj.body,
      obj.contentType,
      obj.contentLength,
      obj.etag,
      obj.lastModified.toISOString(),
      JSON.stringify(obj.metadata),
      obj.contentLanguage ?? null,
      obj.contentDisposition ?? null,
      obj.cacheControl ?? null,
      obj.contentEncoding ?? null,
      obj.parts ? JSON.stringify(obj.parts) : null,
      obj.checksumAlgorithm ?? null,
      obj.checksumValue ?? null,
      obj.checksumType ?? null,
      obj.partChecksums ? JSON.stringify(obj.partChecksums) : null,
    );
  }

  deleteObject(bucket: string, key: string): void {
    this.stmts.deleteObject.run(bucket, key);
  }

  deleteObjectsByBucket(bucket: string): void {
    this.stmts.deleteObjectsByBucket.run(bucket);
  }

  deleteAllObjects(): void {
    this.stmts.deleteAllObjects.run();
  }

  readBody(bucket: string, key: string): Buffer {
    const row = this.stmts.readBody.get(bucket, key) as { body: Uint8Array } | undefined;
    if (!row) {
      throw new Error(`Object not found in persistence: ${bucket}/${key}`);
    }
    return Buffer.from(row.body);
  }

  renameObject(bucket: string, sourceKey: string, destKey: string): void {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM s3_objects WHERE bucket = ? AND key = ?")
        .get(bucket, sourceKey) as Record<string, unknown> | undefined;
      if (!row) return;
      this.stmts.deleteObject.run(bucket, sourceKey);
      const r = row as Record<string, string | number | null | Buffer>;
      this.stmts.upsertObject.run(
        bucket,
        destKey,
        r.body,
        r.content_type,
        r.content_length,
        r.etag,
        r.last_modified,
        r.metadata,
        r.content_language,
        r.content_disposition,
        r.cache_control,
        r.content_encoding,
        r.parts,
        r.checksum_algorithm,
        r.checksum_value,
        r.checksum_type,
        r.part_checksums,
      );
    });
  }

  // ── S3 Multipart Upload write-through ──

  insertMultipartUpload(upload: MultipartUpload): void {
    this.stmts.insertMultipartUpload.run(
      upload.uploadId,
      upload.bucket,
      upload.key,
      upload.contentType,
      JSON.stringify(upload.metadata),
      upload.initiated.toISOString(),
      upload.contentLanguage ?? null,
      upload.contentDisposition ?? null,
      upload.cacheControl ?? null,
      upload.contentEncoding ?? null,
      upload.checksumAlgorithm ?? null,
    );
  }

  upsertMultipartPart(uploadId: string, part: MultipartPart): void {
    this.stmts.upsertMultipartPart.run(
      uploadId,
      part.partNumber,
      part.body,
      part.etag,
      part.lastModified.toISOString(),
      part.checksumValue ?? null,
    );
  }

  deleteMultipartUpload(uploadId: string): void {
    this.stmts.deleteMultipartUpload.run(uploadId);
  }

  completeMultipartUpload(uploadId: string, bucket: string, obj: S3Object): void {
    this.transaction(() => {
      this.upsertObject(bucket, obj);
      this.stmts.deleteMultipartUpload.run(uploadId);
    });
  }

  deleteAllMultipartUploads(): void {
    this.transaction(() => {
      this.stmts.deleteAllMultipartParts.run();
      this.stmts.deleteAllMultipartUploads.run();
    });
  }

  // ── Bulk operations ──

  clearMessagesAndObjects(): void {
    this.transaction(() => {
      this.stmts.deleteAllMessages.run();
      this.stmts.deleteAllObjects.run();
      this.stmts.deleteAllMultipartParts.run();
      this.stmts.deleteAllMultipartUploads.run();
    });
  }

  purgeAll(): void {
    this.transaction(() => {
      this.stmts.deleteAllMultipartParts.run();
      this.stmts.deleteAllMultipartUploads.run();
      this.stmts.deleteAllObjects.run();
      this.stmts.deleteAllMessages.run();
      this.db.prepare("DELETE FROM s3_buckets").run();
      this.db.prepare("DELETE FROM sns_subscriptions").run();
      this.db.prepare("DELETE FROM sns_topics").run();
      this.db.prepare("DELETE FROM sqs_queues").run();
    });
  }

  // ── Load on startup ──

  load(sqsStore: SqsStore, snsStore: SnsStore, s3Store: S3Store): void {
    this.loadSqsAndSns(sqsStore, snsStore);
    this.loadS3(s3Store);
  }

  loadSqsAndSns(sqsStore: SqsStore, snsStore: SnsStore): void {
    this.loadSqsQueues(sqsStore);
    this.loadSnsTopics(snsStore);
    this.loadSnsSubscriptions(snsStore);
  }

  loadS3(s3Store: S3Store): void {
    this.loadS3Buckets(s3Store);
    this.loadS3Objects(s3Store);
    this.loadS3MultipartUploads(s3Store);
  }

  private loadSqsQueues(sqsStore: SqsStore): void {
    const rows = this.stmts.loadQueues.all() as Array<{
      name: string;
      url: string;
      arn: string;
      attributes: string;
      tags: string;
      created_timestamp: number;
      last_modified_timestamp: number;
      sequence_counter: number;
    }>;

    for (const row of rows) {
      const attributes = JSON.parse(row.attributes);
      const tags = JSON.parse(row.tags);
      const queue = sqsStore.createQueue(row.name, row.url, row.arn, attributes, tags);

      // Restore timestamps and sequence counter (createQueue will have re-persisted,
      // so overwrite in-memory values without triggering another write)
      (queue as { createdTimestamp: number }).createdTimestamp = row.created_timestamp;
      queue.lastModifiedTimestamp = row.last_modified_timestamp;
      queue.sequenceCounter = row.sequence_counter;

      this.loadSqsMessages(queue);
    }
  }

  private loadSqsMessages(queue: SqsQueue): void {
    const now = Date.now();
    const rows = this.stmts.loadMessages.all(queue.name) as Array<{
      message_id: string;
      queue_name: string;
      body: string;
      md5_of_body: string;
      message_attributes: string;
      md5_of_message_attributes: string;
      sent_timestamp: number;
      approximate_receive_count: number;
      approximate_first_receive_timestamp: number | null;
      delay_until: number | null;
      message_group_id: string | null;
      message_deduplication_id: string | null;
      sequence_number: string | null;
      receipt_handle: string | null;
      visibility_deadline: number | null;
    }>;

    for (const row of rows) {
      const msg: SqsMessage = {
        messageId: row.message_id,
        body: row.body,
        md5OfBody: row.md5_of_body,
        messageAttributes: JSON.parse(row.message_attributes),
        md5OfMessageAttributes: row.md5_of_message_attributes,
        sentTimestamp: row.sent_timestamp,
        approximateReceiveCount: row.approximate_receive_count,
        approximateFirstReceiveTimestamp: row.approximate_first_receive_timestamp ?? undefined,
        delayUntil: row.delay_until ?? undefined,
        messageGroupId: row.message_group_id ?? undefined,
        messageDeduplicationId: row.message_deduplication_id ?? undefined,
        sequenceNumber: row.sequence_number ?? undefined,
      };

      // Recalculate message state from persisted timestamps
      if (row.receipt_handle && row.visibility_deadline) {
        if (row.visibility_deadline > now) {
          // Still inflight
          queue.inflightMessages.set(row.receipt_handle, {
            message: msg,
            receiptHandle: row.receipt_handle,
            visibilityDeadline: row.visibility_deadline,
          });
          if (msg.messageGroupId && queue.isFifo()) {
            const count = queue.fifoLockedGroups.get(msg.messageGroupId) ?? 0;
            queue.fifoLockedGroups.set(msg.messageGroupId, count + 1);
          }
          continue;
        }
        // Visibility expired — clear inflight state in DB
        this.stmts.updateMessageInflight.run(
          null,
          null,
          row.approximate_receive_count,
          row.approximate_first_receive_timestamp,
          row.message_id,
        );
      }

      // Place into ready or delayed
      if (msg.delayUntil && msg.delayUntil > now) {
        if (queue.isFifo()) {
          const groupId = msg.messageGroupId ?? "__default";
          const group = queue.fifoDelayed.get(groupId) ?? [];
          group.push(msg);
          queue.fifoDelayed.set(groupId, group);
        } else {
          queue.delayedMessages.push(msg);
        }
      } else {
        if (queue.isFifo()) {
          const groupId = msg.messageGroupId ?? "__default";
          const group = queue.fifoMessages.get(groupId) ?? [];
          group.push(msg);
          queue.fifoMessages.set(groupId, group);
        } else {
          queue.messages.push(msg);
        }
      }
    }
  }

  private loadSnsTopics(snsStore: SnsStore): void {
    const rows = this.stmts.loadTopics.all() as Array<{
      arn: string;
      name: string;
      attributes: string;
      tags: string;
      subscription_arns: string;
    }>;

    for (const row of rows) {
      const topic: SnsTopic = {
        arn: row.arn,
        name: row.name,
        attributes: JSON.parse(row.attributes),
        tags: new Map(Object.entries(JSON.parse(row.tags))),
        subscriptionArns: JSON.parse(row.subscription_arns),
      };
      snsStore.topics.set(row.arn, topic);
    }
  }

  private loadSnsSubscriptions(snsStore: SnsStore): void {
    const rows = this.stmts.loadSubscriptions.all() as Array<{
      arn: string;
      topic_arn: string;
      protocol: string;
      endpoint: string;
      confirmed: number;
      attributes: string;
    }>;

    for (const row of rows) {
      const sub: SnsSubscription = {
        arn: row.arn,
        topicArn: row.topic_arn,
        protocol: row.protocol,
        endpoint: row.endpoint,
        confirmed: row.confirmed === 1,
        attributes: JSON.parse(row.attributes),
      };
      snsStore.subscriptions.set(row.arn, sub);
    }
  }

  private loadS3Buckets(s3Store: S3Store): void {
    const rows = this.stmts.loadBuckets.all() as Array<{
      name: string;
      creation_date: string;
      type: string;
    }>;

    for (const row of rows) {
      s3Store.createBucket(row.name, row.type as BucketType);
      s3Store.setBucketCreationDate(row.name, new Date(row.creation_date));
    }
  }

  private loadS3Objects(s3Store: S3Store): void {
    // Load metadata only — bodies are read on demand via readBody()
    const rows = this.stmts.loadObjectsMeta.all() as Array<{
      bucket: string;
      key: string;
      content_type: string;
      content_length: number;
      etag: string;
      last_modified: string;
      metadata: string;
      content_language: string | null;
      content_disposition: string | null;
      cache_control: string | null;
      content_encoding: string | null;
      parts: string | null;
      checksum_algorithm: string | null;
      checksum_value: string | null;
      checksum_type: string | null;
      part_checksums: string | null;
    }>;

    for (const row of rows) {
      const obj: S3Object = {
        key: row.key,
        body: Buffer.alloc(0),
        contentType: row.content_type,
        contentLength: row.content_length,
        etag: row.etag,
        lastModified: new Date(row.last_modified),
        metadata: JSON.parse(row.metadata),
        ...(row.content_language && { contentLanguage: row.content_language }),
        ...(row.content_disposition && { contentDisposition: row.content_disposition }),
        ...(row.cache_control && { cacheControl: row.cache_control }),
        ...(row.content_encoding && { contentEncoding: row.content_encoding }),
        ...(row.parts && { parts: JSON.parse(row.parts) }),
        ...(row.checksum_algorithm && {
          checksumAlgorithm: row.checksum_algorithm as ChecksumAlgorithm,
        }),
        ...(row.checksum_value && { checksumValue: row.checksum_value }),
        ...(row.checksum_type && {
          checksumType: row.checksum_type as "FULL_OBJECT" | "COMPOSITE",
        }),
        ...(row.part_checksums && { partChecksums: JSON.parse(row.part_checksums) }),
      };
      s3Store.restoreObject(row.bucket, obj);
    }
  }

  private loadS3MultipartUploads(s3Store: S3Store): void {
    const uploadRows = this.stmts.loadMultipartUploads.all() as Array<{
      upload_id: string;
      bucket: string;
      key: string;
      content_type: string;
      metadata: string;
      initiated: string;
      content_language: string | null;
      content_disposition: string | null;
      cache_control: string | null;
      content_encoding: string | null;
      checksum_algorithm: string | null;
    }>;

    for (const row of uploadRows) {
      const upload: MultipartUpload = {
        uploadId: row.upload_id,
        bucket: row.bucket,
        key: row.key,
        contentType: row.content_type,
        metadata: JSON.parse(row.metadata),
        parts: new Map(),
        initiated: new Date(row.initiated),
        ...(row.content_language && { contentLanguage: row.content_language }),
        ...(row.content_disposition && { contentDisposition: row.content_disposition }),
        ...(row.cache_control && { cacheControl: row.cache_control }),
        ...(row.content_encoding && { contentEncoding: row.content_encoding }),
        ...(row.checksum_algorithm && {
          checksumAlgorithm: row.checksum_algorithm as ChecksumAlgorithm,
        }),
      };

      const partRows = this.stmts.loadMultipartParts.all(row.upload_id) as Array<{
        upload_id: string;
        part_number: number;
        body: Uint8Array;
        etag: string;
        last_modified: string;
        checksum_value: string | null;
      }>;

      for (const pRow of partRows) {
        upload.parts.set(pRow.part_number, {
          partNumber: pRow.part_number,
          body: Buffer.from(pRow.body),
          etag: pRow.etag,
          lastModified: new Date(pRow.last_modified),
          ...(pRow.checksum_value && { checksumValue: pRow.checksum_value }),
        });
      }

      s3Store.restoreMultipartUpload(upload);
    }
  }

  close(): void {
    this.db.close();
  }
}
