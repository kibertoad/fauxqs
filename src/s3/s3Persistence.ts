import type { S3Store, BucketType } from "./s3Store.ts";
import type { S3Object, MultipartUpload, MultipartPart } from "./s3Types.ts";

export interface S3PersistenceProvider {
  // Bucket ops
  insertBucket(name: string, creationDate: Date, type: BucketType): void | Promise<void>;
  deleteBucket(name: string): void | Promise<void>;
  saveBucketLifecycleConfiguration(bucket: string, config: string): void | Promise<void>;
  deleteBucketLifecycleConfiguration(bucket: string): void | Promise<void>;

  // Object ops (write-through)
  upsertObject(bucket: string, obj: S3Object): void | Promise<void>;
  deleteObject(bucket: string, key: string): void | Promise<void>;
  deleteObjectsByBucket(bucket: string): void | Promise<void>;
  deleteAllObjects(): void | Promise<void>;
  renameObject(bucket: string, sourceKey: string, destKey: string): void | Promise<void>;

  // On-demand body read
  readBody(bucket: string, key: string): Buffer | Promise<Buffer>;

  // Multipart ops
  insertMultipartUpload(upload: MultipartUpload): void | Promise<void>;
  upsertMultipartPart(uploadId: string, part: MultipartPart): void | Promise<void>;
  deleteMultipartUpload(uploadId: string): void | Promise<void>;
  completeMultipartUpload(uploadId: string, bucket: string, obj: S3Object): void | Promise<void>;
  deleteAllMultipartUploads(): void | Promise<void>;

  // Startup load (metadata only for objects; full load for multipart parts)
  loadS3(s3Store: S3Store): void | Promise<void>;

  // Purge all S3 data (buckets, objects, multipart uploads)
  purgeAll(): void | Promise<void>;

  close(): void | Promise<void>;
}
