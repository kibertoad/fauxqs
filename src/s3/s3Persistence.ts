import type { S3Store, BucketType } from "./s3Store.ts";
import type { S3Object, MultipartUpload, MultipartPart } from "./s3Types.ts";

export interface S3PersistenceProvider {
  // Bucket ops
  insertBucket(name: string, creationDate: Date, type: BucketType): void;
  deleteBucket(name: string): void;

  // Object ops (write-through)
  upsertObject(bucket: string, obj: S3Object): void;
  deleteObject(bucket: string, key: string): void;
  deleteObjectsByBucket(bucket: string): void;
  deleteAllObjects(): void;
  renameObject(bucket: string, sourceKey: string, destKey: string): void;

  // On-demand body read
  readBody(bucket: string, key: string): Buffer;

  // Multipart ops
  insertMultipartUpload(upload: MultipartUpload): void;
  upsertMultipartPart(uploadId: string, part: MultipartPart): void;
  deleteMultipartUpload(uploadId: string): void;
  completeMultipartUpload(uploadId: string, bucket: string, obj: S3Object): void;
  deleteAllMultipartUploads(): void;

  // Startup load (metadata only for objects; full load for multipart parts)
  loadS3(s3Store: S3Store): void;

  // Purge all S3 data (buckets, objects, multipart uploads)
  purgeAll(): void;

  close(): void;
}
