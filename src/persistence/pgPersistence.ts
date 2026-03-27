import pg from "pg";
import type { SqsStore, SqsQueue } from "../sqs/sqsStore.ts";
import type { SqsMessage } from "../sqs/sqsTypes.ts";
import type { SnsStore } from "../sns/snsStore.ts";
import type { SnsTopic, SnsSubscription } from "../sns/snsTypes.ts";
import type { S3Store, BucketType } from "../s3/s3Store.ts";
import type { S3Object, MultipartUpload, MultipartPart } from "../s3/s3Types.ts";
import type { ChecksumAlgorithm } from "../s3/s3Types.ts";
import type { PersistenceProvider } from "./persistenceProvider.ts";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sqs_queues (
    name TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    arn TEXT NOT NULL,
    attributes TEXT NOT NULL,
    tags TEXT NOT NULL,
    created_timestamp BIGINT NOT NULL,
    last_modified_timestamp BIGINT NOT NULL,
    sequence_counter BIGINT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS sqs_messages (
    message_id TEXT PRIMARY KEY,
    queue_name TEXT NOT NULL REFERENCES sqs_queues(name) ON DELETE CASCADE,
    body TEXT NOT NULL,
    md5_of_body TEXT NOT NULL,
    message_attributes TEXT NOT NULL,
    md5_of_message_attributes TEXT NOT NULL,
    sent_timestamp BIGINT NOT NULL,
    approximate_receive_count BIGINT NOT NULL DEFAULT 0,
    approximate_first_receive_timestamp BIGINT,
    delay_until BIGINT,
    message_group_id TEXT,
    message_deduplication_id TEXT,
    sequence_number TEXT,
    receipt_handle TEXT,
    visibility_deadline BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS sns_topics (
    arn TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    attributes TEXT NOT NULL,
    tags TEXT NOT NULL,
    subscription_arns TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sns_subscriptions (
    arn TEXT PRIMARY KEY,
    topic_arn TEXT NOT NULL,
    protocol TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    attributes TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS s3_buckets (
    name TEXT PRIMARY KEY,
    creation_date TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'general-purpose'
  )`,
  `CREATE TABLE IF NOT EXISTS s3_bucket_lifecycle_configurations (
    bucket TEXT PRIMARY KEY REFERENCES s3_buckets(name) ON DELETE CASCADE,
    configuration TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS s3_objects (
    bucket TEXT NOT NULL,
    key TEXT NOT NULL,
    body BYTEA NOT NULL,
    content_type TEXT NOT NULL,
    content_length BIGINT NOT NULL,
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
  )`,
  `CREATE TABLE IF NOT EXISTS s3_multipart_uploads (
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
  )`,
  `CREATE TABLE IF NOT EXISTS s3_multipart_parts (
    upload_id TEXT NOT NULL REFERENCES s3_multipart_uploads(upload_id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL,
    body BYTEA NOT NULL,
    etag TEXT NOT NULL,
    last_modified TEXT NOT NULL,
    checksum_value TEXT,
    PRIMARY KEY (upload_id, part_number)
  )`,
];

export class PgPersistence implements PersistenceProvider {
  private pool: pg.Pool;

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async create(connectionString: string): Promise<PgPersistence> {
    const pool = new pg.Pool({ connectionString });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const stmt of SCHEMA_STATEMENTS) {
        await client.query(stmt);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return new PgPersistence(pool);
  }

  // ── SQS Queue write-through ──

  async insertQueue(queue: SqsQueue): Promise<void> {
    await this.pool.query(
      `INSERT INTO sqs_queues (name, url, arn, attributes, tags, created_timestamp, last_modified_timestamp, sequence_counter)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (name) DO UPDATE SET
         url = EXCLUDED.url,
         arn = EXCLUDED.arn,
         attributes = EXCLUDED.attributes,
         tags = EXCLUDED.tags,
         created_timestamp = EXCLUDED.created_timestamp,
         last_modified_timestamp = EXCLUDED.last_modified_timestamp,
         sequence_counter = EXCLUDED.sequence_counter`,
      [
        queue.name,
        queue.url,
        queue.arn,
        JSON.stringify(queue.attributes),
        JSON.stringify(Object.fromEntries(queue.tags)),
        queue.createdTimestamp,
        queue.lastModifiedTimestamp,
        queue.sequenceCounter,
      ],
    );
  }

  async deleteQueue(name: string): Promise<void> {
    await this.pool.query("DELETE FROM sqs_queues WHERE name = $1", [name]);
  }

  async updateQueueAttributes(
    name: string,
    attributes: Record<string, string>,
    lastModified: number,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE sqs_queues SET attributes = $1, last_modified_timestamp = $2 WHERE name = $3",
      [JSON.stringify(attributes), lastModified, name],
    );
  }

  async updateQueueSequenceCounter(name: string, counter: number): Promise<void> {
    await this.pool.query("UPDATE sqs_queues SET sequence_counter = $1 WHERE name = $2", [
      counter,
      name,
    ]);
  }

  // ── SQS Message write-through ──

  async insertMessage(queueName: string, msg: SqsMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO sqs_messages (
        message_id, queue_name, body, md5_of_body, message_attributes, md5_of_message_attributes,
        sent_timestamp, approximate_receive_count, approximate_first_receive_timestamp,
        delay_until, message_group_id, message_deduplication_id, sequence_number,
        receipt_handle, visibility_deadline
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (message_id) DO UPDATE SET
        queue_name = EXCLUDED.queue_name,
        body = EXCLUDED.body,
        md5_of_body = EXCLUDED.md5_of_body,
        message_attributes = EXCLUDED.message_attributes,
        md5_of_message_attributes = EXCLUDED.md5_of_message_attributes,
        sent_timestamp = EXCLUDED.sent_timestamp,
        approximate_receive_count = EXCLUDED.approximate_receive_count,
        approximate_first_receive_timestamp = EXCLUDED.approximate_first_receive_timestamp,
        delay_until = EXCLUDED.delay_until,
        message_group_id = EXCLUDED.message_group_id,
        message_deduplication_id = EXCLUDED.message_deduplication_id,
        sequence_number = EXCLUDED.sequence_number,
        receipt_handle = EXCLUDED.receipt_handle,
        visibility_deadline = EXCLUDED.visibility_deadline`,
      [
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
      ],
    );
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.pool.query("DELETE FROM sqs_messages WHERE message_id = $1", [messageId]);
  }

  async updateMessageInflight(
    messageId: string,
    receiptHandle: string,
    visibilityDeadline: number,
    receiveCount: number,
    firstReceiveTimestamp: number | undefined,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE sqs_messages SET receipt_handle = $1, visibility_deadline = $2, approximate_receive_count = $3, approximate_first_receive_timestamp = $4
       WHERE message_id = $5`,
      [receiptHandle, visibilityDeadline, receiveCount, firstReceiveTimestamp ?? null, messageId],
    );
  }

  async updateMessageReady(messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE sqs_messages SET receipt_handle = NULL, visibility_deadline = NULL
       WHERE message_id = $1`,
      [messageId],
    );
  }

  async deleteQueueMessages(queueName: string): Promise<void> {
    await this.pool.query("DELETE FROM sqs_messages WHERE queue_name = $1", [queueName]);
  }

  async deleteAllMessages(): Promise<void> {
    await this.pool.query("DELETE FROM sqs_messages");
  }

  // ── SNS Topic write-through ──

  async insertTopic(topic: SnsTopic): Promise<void> {
    await this.pool.query(
      `INSERT INTO sns_topics (arn, name, attributes, tags, subscription_arns)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (arn) DO UPDATE SET
         name = EXCLUDED.name,
         attributes = EXCLUDED.attributes,
         tags = EXCLUDED.tags,
         subscription_arns = EXCLUDED.subscription_arns`,
      [
        topic.arn,
        topic.name,
        JSON.stringify(topic.attributes),
        JSON.stringify(Object.fromEntries(topic.tags)),
        JSON.stringify(topic.subscriptionArns),
      ],
    );
  }

  async deleteTopic(arn: string): Promise<void> {
    await this.pool.query("DELETE FROM sns_topics WHERE arn = $1", [arn]);
  }

  async updateTopicAttributes(arn: string, attributes: Record<string, string>): Promise<void> {
    await this.pool.query("UPDATE sns_topics SET attributes = $1 WHERE arn = $2", [
      JSON.stringify(attributes),
      arn,
    ]);
  }

  async updateTopicSubscriptionArns(arn: string, arns: string[]): Promise<void> {
    await this.pool.query("UPDATE sns_topics SET subscription_arns = $1 WHERE arn = $2", [
      JSON.stringify(arns),
      arn,
    ]);
  }

  // ── SNS Subscription write-through ──

  async insertSubscription(sub: SnsSubscription): Promise<void> {
    await this.pool.query(
      `INSERT INTO sns_subscriptions (arn, topic_arn, protocol, endpoint, confirmed, attributes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (arn) DO UPDATE SET
         topic_arn = EXCLUDED.topic_arn,
         protocol = EXCLUDED.protocol,
         endpoint = EXCLUDED.endpoint,
         confirmed = EXCLUDED.confirmed,
         attributes = EXCLUDED.attributes`,
      [
        sub.arn,
        sub.topicArn,
        sub.protocol,
        sub.endpoint,
        sub.confirmed ? 1 : 0,
        JSON.stringify(sub.attributes),
      ],
    );
  }

  async deleteSubscription(arn: string): Promise<void> {
    await this.pool.query("DELETE FROM sns_subscriptions WHERE arn = $1", [arn]);
  }

  async updateSubscriptionAttributes(
    arn: string,
    attributes: Record<string, string>,
  ): Promise<void> {
    await this.pool.query("UPDATE sns_subscriptions SET attributes = $1 WHERE arn = $2", [
      JSON.stringify(attributes),
      arn,
    ]);
  }

  // ── S3 Bucket write-through ──

  async insertBucket(name: string, creationDate: Date, type: BucketType): Promise<void> {
    await this.pool.query(
      `INSERT INTO s3_buckets (name, creation_date, type) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET
         creation_date = EXCLUDED.creation_date,
         type = EXCLUDED.type`,
      [name, creationDate.toISOString(), type],
    );
  }

  async deleteBucket(name: string): Promise<void> {
    await this.pool.query("DELETE FROM s3_buckets WHERE name = $1", [name]);
  }

  async saveBucketLifecycleConfiguration(bucket: string, config: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO s3_bucket_lifecycle_configurations (bucket, configuration) VALUES ($1, $2)
       ON CONFLICT (bucket) DO UPDATE SET configuration = EXCLUDED.configuration`,
      [bucket, config],
    );
  }

  async deleteBucketLifecycleConfiguration(bucket: string): Promise<void> {
    await this.pool.query("DELETE FROM s3_bucket_lifecycle_configurations WHERE bucket = $1", [
      bucket,
    ]);
  }

  // ── S3 Object write-through ──

  async upsertObject(bucket: string, obj: S3Object): Promise<void> {
    await this.pool.query(
      `INSERT INTO s3_objects (
        bucket, key, body, content_type, content_length, etag, last_modified, metadata,
        content_language, content_disposition, cache_control, content_encoding,
        parts, checksum_algorithm, checksum_value, checksum_type, part_checksums
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (bucket, key) DO UPDATE SET
        body = EXCLUDED.body,
        content_type = EXCLUDED.content_type,
        content_length = EXCLUDED.content_length,
        etag = EXCLUDED.etag,
        last_modified = EXCLUDED.last_modified,
        metadata = EXCLUDED.metadata,
        content_language = EXCLUDED.content_language,
        content_disposition = EXCLUDED.content_disposition,
        cache_control = EXCLUDED.cache_control,
        content_encoding = EXCLUDED.content_encoding,
        parts = EXCLUDED.parts,
        checksum_algorithm = EXCLUDED.checksum_algorithm,
        checksum_value = EXCLUDED.checksum_value,
        checksum_type = EXCLUDED.checksum_type,
        part_checksums = EXCLUDED.part_checksums`,
      [
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
      ],
    );
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.pool.query("DELETE FROM s3_objects WHERE bucket = $1 AND key = $2", [bucket, key]);
  }

  async deleteObjectsByBucket(bucket: string): Promise<void> {
    await this.pool.query("DELETE FROM s3_objects WHERE bucket = $1", [bucket]);
  }

  async deleteAllObjects(): Promise<void> {
    await this.pool.query("DELETE FROM s3_objects");
  }

  async readBody(bucket: string, key: string): Promise<Buffer> {
    const result = await this.pool.query(
      "SELECT body FROM s3_objects WHERE bucket = $1 AND key = $2",
      [bucket, key],
    );
    if (result.rows.length === 0) {
      throw new Error(`Object not found in persistence: ${bucket}/${key}`);
    }
    return Buffer.from(result.rows[0].body);
  }

  async renameObject(bucket: string, sourceKey: string, destKey: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT * FROM s3_objects WHERE bucket = $1 AND key = $2", [
        bucket,
        sourceKey,
      ]);
      if (result.rows.length === 0) {
        await client.query("COMMIT");
        return;
      }
      const r = result.rows[0];
      await client.query("DELETE FROM s3_objects WHERE bucket = $1 AND key = $2", [
        bucket,
        sourceKey,
      ]);
      await client.query(
        `INSERT INTO s3_objects (
          bucket, key, body, content_type, content_length, etag, last_modified, metadata,
          content_language, content_disposition, cache_control, content_encoding,
          parts, checksum_algorithm, checksum_value, checksum_type, part_checksums
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (bucket, key) DO UPDATE SET
          body = EXCLUDED.body,
          content_type = EXCLUDED.content_type,
          content_length = EXCLUDED.content_length,
          etag = EXCLUDED.etag,
          last_modified = EXCLUDED.last_modified,
          metadata = EXCLUDED.metadata,
          content_language = EXCLUDED.content_language,
          content_disposition = EXCLUDED.content_disposition,
          cache_control = EXCLUDED.cache_control,
          content_encoding = EXCLUDED.content_encoding,
          parts = EXCLUDED.parts,
          checksum_algorithm = EXCLUDED.checksum_algorithm,
          checksum_value = EXCLUDED.checksum_value,
          checksum_type = EXCLUDED.checksum_type,
          part_checksums = EXCLUDED.part_checksums`,
        [
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
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ── S3 Multipart Upload write-through ──

  async insertMultipartUpload(upload: MultipartUpload): Promise<void> {
    await this.pool.query(
      `INSERT INTO s3_multipart_uploads (
        upload_id, bucket, key, content_type, metadata, initiated,
        content_language, content_disposition, cache_control, content_encoding, checksum_algorithm
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (upload_id) DO UPDATE SET
        bucket = EXCLUDED.bucket,
        key = EXCLUDED.key,
        content_type = EXCLUDED.content_type,
        metadata = EXCLUDED.metadata,
        initiated = EXCLUDED.initiated,
        content_language = EXCLUDED.content_language,
        content_disposition = EXCLUDED.content_disposition,
        cache_control = EXCLUDED.cache_control,
        content_encoding = EXCLUDED.content_encoding,
        checksum_algorithm = EXCLUDED.checksum_algorithm`,
      [
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
      ],
    );
  }

  async upsertMultipartPart(uploadId: string, part: MultipartPart): Promise<void> {
    await this.pool.query(
      `INSERT INTO s3_multipart_parts (upload_id, part_number, body, etag, last_modified, checksum_value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (upload_id, part_number) DO UPDATE SET
         body = EXCLUDED.body,
         etag = EXCLUDED.etag,
         last_modified = EXCLUDED.last_modified,
         checksum_value = EXCLUDED.checksum_value`,
      [
        uploadId,
        part.partNumber,
        part.body,
        part.etag,
        part.lastModified.toISOString(),
        part.checksumValue ?? null,
      ],
    );
  }

  async deleteMultipartUpload(uploadId: string): Promise<void> {
    await this.pool.query("DELETE FROM s3_multipart_uploads WHERE upload_id = $1", [uploadId]);
  }

  async completeMultipartUpload(uploadId: string, bucket: string, obj: S3Object): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Upsert the completed object
      await client.query(
        `INSERT INTO s3_objects (
          bucket, key, body, content_type, content_length, etag, last_modified, metadata,
          content_language, content_disposition, cache_control, content_encoding,
          parts, checksum_algorithm, checksum_value, checksum_type, part_checksums
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (bucket, key) DO UPDATE SET
          body = EXCLUDED.body,
          content_type = EXCLUDED.content_type,
          content_length = EXCLUDED.content_length,
          etag = EXCLUDED.etag,
          last_modified = EXCLUDED.last_modified,
          metadata = EXCLUDED.metadata,
          content_language = EXCLUDED.content_language,
          content_disposition = EXCLUDED.content_disposition,
          cache_control = EXCLUDED.cache_control,
          content_encoding = EXCLUDED.content_encoding,
          parts = EXCLUDED.parts,
          checksum_algorithm = EXCLUDED.checksum_algorithm,
          checksum_value = EXCLUDED.checksum_value,
          checksum_type = EXCLUDED.checksum_type,
          part_checksums = EXCLUDED.part_checksums`,
        [
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
        ],
      );
      // Delete the multipart upload (cascade deletes parts)
      await client.query("DELETE FROM s3_multipart_uploads WHERE upload_id = $1", [uploadId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteAllMultipartUploads(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM s3_multipart_parts");
      await client.query("DELETE FROM s3_multipart_uploads");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Bulk operations ──

  async clearMessagesAndObjects(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM sqs_messages");
      await client.query("DELETE FROM s3_objects");
      await client.query("DELETE FROM s3_multipart_parts");
      await client.query("DELETE FROM s3_multipart_uploads");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async purgeAll(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM s3_multipart_parts");
      await client.query("DELETE FROM s3_multipart_uploads");
      await client.query("DELETE FROM s3_objects");
      await client.query("DELETE FROM sqs_messages");
      await client.query("DELETE FROM s3_bucket_lifecycle_configurations");
      await client.query("DELETE FROM s3_buckets");
      await client.query("DELETE FROM sns_subscriptions");
      await client.query("DELETE FROM sns_topics");
      await client.query("DELETE FROM sqs_queues");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Load on startup ──

  async load(sqsStore: SqsStore, snsStore: SnsStore, s3Store: S3Store): Promise<void> {
    await this.loadSqsAndSns(sqsStore, snsStore);
    await this.loadS3(s3Store);
  }

  async loadSqsAndSns(sqsStore: SqsStore, snsStore: SnsStore): Promise<void> {
    await this.loadSqsQueues(sqsStore);
    await this.loadSnsTopics(snsStore);
    await this.loadSnsSubscriptions(snsStore);
  }

  async loadS3(s3Store: S3Store): Promise<void> {
    await this.loadS3Buckets(s3Store);
    await this.loadS3BucketLifecycleConfigurations(s3Store);
    await this.loadS3Objects(s3Store);
    await this.loadS3MultipartUploads(s3Store);
  }

  private async loadSqsQueues(sqsStore: SqsStore): Promise<void> {
    const result = await this.pool.query("SELECT * FROM sqs_queues");

    for (const row of result.rows) {
      const attributes = JSON.parse(row.attributes);
      const tags = JSON.parse(row.tags);
      const queue = await sqsStore.createQueue(row.name, row.url, row.arn, attributes, tags);

      // Restore timestamps and sequence counter (createQueue will have re-persisted,
      // so overwrite in-memory values without triggering another write)
      (queue as { createdTimestamp: number }).createdTimestamp = Number(row.created_timestamp);
      queue.lastModifiedTimestamp = Number(row.last_modified_timestamp);
      queue.sequenceCounter = Number(row.sequence_counter);

      await this.loadSqsMessages(queue);
    }
  }

  private async loadSqsMessages(queue: SqsQueue): Promise<void> {
    const now = Date.now();
    const result = await this.pool.query("SELECT * FROM sqs_messages WHERE queue_name = $1", [
      queue.name,
    ]);

    for (const row of result.rows) {
      const msg: SqsMessage = {
        messageId: row.message_id,
        body: row.body,
        md5OfBody: row.md5_of_body,
        messageAttributes: JSON.parse(row.message_attributes),
        md5OfMessageAttributes: row.md5_of_message_attributes,
        sentTimestamp: Number(row.sent_timestamp),
        approximateReceiveCount: Number(row.approximate_receive_count),
        approximateFirstReceiveTimestamp:
          row.approximate_first_receive_timestamp != null
            ? Number(row.approximate_first_receive_timestamp)
            : undefined,
        delayUntil: row.delay_until != null ? Number(row.delay_until) : undefined,
        messageGroupId: row.message_group_id ?? undefined,
        messageDeduplicationId: row.message_deduplication_id ?? undefined,
        sequenceNumber: row.sequence_number ?? undefined,
      };

      // Recalculate message state from persisted timestamps
      const visibilityDeadline =
        row.visibility_deadline != null ? Number(row.visibility_deadline) : null;
      if (row.receipt_handle && visibilityDeadline) {
        if (visibilityDeadline > now) {
          // Still inflight
          queue.inflightMessages.set(row.receipt_handle, {
            message: msg,
            receiptHandle: row.receipt_handle,
            visibilityDeadline,
          });
          if (msg.messageGroupId && queue.isFifo()) {
            const count = queue.fifoLockedGroups.get(msg.messageGroupId) ?? 0;
            queue.fifoLockedGroups.set(msg.messageGroupId, count + 1);
          }
          continue;
        }
        // Visibility expired — clear inflight state in DB
        await this.pool.query(
          `UPDATE sqs_messages SET receipt_handle = $1, visibility_deadline = $2, approximate_receive_count = $3, approximate_first_receive_timestamp = $4
           WHERE message_id = $5`,
          [
            null,
            null,
            Number(row.approximate_receive_count),
            row.approximate_first_receive_timestamp != null
              ? Number(row.approximate_first_receive_timestamp)
              : null,
            row.message_id,
          ],
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

  private async loadSnsTopics(snsStore: SnsStore): Promise<void> {
    const result = await this.pool.query("SELECT * FROM sns_topics");

    for (const row of result.rows) {
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

  private async loadSnsSubscriptions(snsStore: SnsStore): Promise<void> {
    const result = await this.pool.query("SELECT * FROM sns_subscriptions");

    for (const row of result.rows) {
      const sub: SnsSubscription = {
        arn: row.arn,
        topicArn: row.topic_arn,
        protocol: row.protocol,
        endpoint: row.endpoint,
        confirmed: Boolean(row.confirmed),
        attributes: JSON.parse(row.attributes),
      };
      snsStore.subscriptions.set(row.arn, sub);
    }
  }

  private async loadS3Buckets(s3Store: S3Store): Promise<void> {
    const result = await this.pool.query("SELECT * FROM s3_buckets");

    for (const row of result.rows) {
      await s3Store.createBucket(row.name, row.type as BucketType);
      s3Store.setBucketCreationDate(row.name, new Date(row.creation_date));
    }
  }

  private async loadS3BucketLifecycleConfigurations(s3Store: S3Store): Promise<void> {
    const result = await this.pool.query("SELECT * FROM s3_bucket_lifecycle_configurations");

    for (const row of result.rows) {
      s3Store.restoreBucketLifecycleConfiguration(row.bucket, row.configuration);
    }
  }

  private async loadS3Objects(s3Store: S3Store): Promise<void> {
    // Load metadata only — bodies are read on demand via readBody()
    const result = await this.pool.query(
      `SELECT bucket, key, content_type, content_length, etag, last_modified, metadata,
              content_language, content_disposition, cache_control, content_encoding,
              parts, checksum_algorithm, checksum_value, checksum_type, part_checksums
       FROM s3_objects`,
    );

    for (const row of result.rows) {
      const obj: S3Object = {
        key: row.key,
        body: Buffer.alloc(0),
        contentType: row.content_type,
        contentLength: Number(row.content_length),
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

  private async loadS3MultipartUploads(s3Store: S3Store): Promise<void> {
    const uploadResult = await this.pool.query("SELECT * FROM s3_multipart_uploads");

    for (const row of uploadResult.rows) {
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

      const partResult = await this.pool.query(
        "SELECT * FROM s3_multipart_parts WHERE upload_id = $1",
        [row.upload_id],
      );

      for (const pRow of partResult.rows) {
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
