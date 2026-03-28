/**
 * Tracked store subclasses for multi-tenant usage tracking.
 *
 * These override lookup methods to call `usageTracker.touch()` on every access.
 * When tenant management is disabled, the base store classes are used directly —
 * no tenant code runs on the hot path.
 *
 * MAINTENANCE: if a new public method is added to SqsStore, SnsStore, or S3Store
 * that represents a "usage" of a resource (queue lookup, topic lookup, bucket
 * operation), add a corresponding override here. The base store classes have a
 * NOTE comment reminding contributors of this.
 */
import { SqsStore } from "../sqs/sqsStore.ts";
import type { SqsQueue } from "../sqs/sqsStore.ts";
import { SnsStore } from "../sns/snsStore.ts";
import type { SnsTopic } from "../sns/snsTypes.ts";
import { S3Store } from "../s3/s3Store.ts";
import type { S3Object, ChecksumAlgorithm } from "../s3/s3Types.ts";
import type { UsageTracker } from "./usageTracker.ts";

/**
 * SqsStore subclass that touches the usage tracker on every queue lookup.
 * Used only when tenant management is enabled — otherwise plain SqsStore is used.
 */
export class TrackedSqsStore extends SqsStore {
  private readonly tracker: UsageTracker;

  constructor(tracker: UsageTracker) {
    super();
    this.tracker = tracker;
  }

  override getQueue(url: string): SqsQueue | undefined {
    const queue = super.getQueue(url);
    if (queue) this.tracker.touch(queue.name);
    return queue;
  }

  override getQueueByName(name: string): SqsQueue | undefined {
    const queue = super.getQueueByName(name);
    if (queue) this.tracker.touch(queue.name);
    return queue;
  }

  override getQueueByArn(arn: string): SqsQueue | undefined {
    const queue = super.getQueueByArn(arn);
    if (queue) this.tracker.touch(queue.name);
    return queue;
  }
}

/**
 * SnsStore subclass that touches the usage tracker on topic lookup.
 */
export class TrackedSnsStore extends SnsStore {
  private readonly tracker: UsageTracker;

  constructor(tracker: UsageTracker) {
    super();
    this.tracker = tracker;
  }

  override getTopic(arn: string): SnsTopic | undefined {
    const topic = super.getTopic(arn);
    if (topic) this.tracker.touch(topic.name);
    return topic;
  }
}

/**
 * S3Store subclass that touches the usage tracker on bucket operations.
 * Only methods that represent real "usage" of a bucket are overridden.
 * uploadPart is excluded — createMultipartUpload and completeMultipartUpload
 * cover the lifecycle, and uploadPart can be called thousands of times per object.
 */
export class TrackedS3Store extends S3Store {
  private readonly tracker: UsageTracker;

  constructor(tracker: UsageTracker) {
    super();
    this.tracker = tracker;
  }

  override putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType?: string,
    metadata?: Record<string, string>,
    systemMetadata?: {
      contentLanguage?: string;
      contentDisposition?: string;
      cacheControl?: string;
      contentEncoding?: string;
    },
    checksumData?: {
      algorithm: ChecksumAlgorithm;
      value: string;
      type: "FULL_OBJECT" | "COMPOSITE";
      partChecksums?: string[];
    },
  ): S3Object {
    this.tracker.touch(bucket);
    return super.putObject(bucket, key, body, contentType, metadata, systemMetadata, checksumData);
  }

  override getObject(bucket: string, key: string): S3Object {
    this.tracker.touch(bucket);
    return super.getObject(bucket, key);
  }

  override deleteObject(bucket: string, key: string): void {
    this.tracker.touch(bucket);
    super.deleteObject(bucket, key);
  }

  override headObject(bucket: string, key: string): S3Object {
    this.tracker.touch(bucket);
    return super.headObject(bucket, key);
  }

  override listObjects(
    bucket: string,
    options?: {
      prefix?: string;
      delimiter?: string;
      maxKeys?: number;
      startAfter?: string;
      marker?: string;
    },
  ): { objects: S3Object[]; commonPrefixes: string[]; isTruncated: boolean } {
    this.tracker.touch(bucket);
    return super.listObjects(bucket, options);
  }

  override renameObject(bucket: string, sourceKey: string, destKey: string): void {
    this.tracker.touch(bucket);
    super.renameObject(bucket, sourceKey, destKey);
  }

  override createMultipartUpload(
    bucket: string,
    key: string,
    contentType?: string,
    metadata?: Record<string, string>,
    systemMetadata?: {
      contentLanguage?: string;
      contentDisposition?: string;
      cacheControl?: string;
      contentEncoding?: string;
    },
    checksumAlgorithm?: ChecksumAlgorithm,
  ): string {
    this.tracker.touch(bucket);
    return super.createMultipartUpload(
      bucket,
      key,
      contentType,
      metadata,
      systemMetadata,
      checksumAlgorithm,
    );
  }

  // completeMultipartUpload is not overridden — the bucket was already touched
  // by createMultipartUpload, and the upload object (which holds the bucket name)
  // is in a private field of the base class.
}
