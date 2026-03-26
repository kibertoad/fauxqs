import { createHash, randomUUID } from "node:crypto";
import { S3Error } from "../common/errors.ts";
import type { MessageSpy } from "../spy.ts";
import type { S3PersistenceProvider } from "./s3Persistence.ts";
import type { S3Object, MultipartUpload, ChecksumAlgorithm } from "./s3Types.ts";
import { computeCompositeChecksum } from "./checksum.ts";

export type BucketType = "general-purpose" | "directory";

export class S3Store {
  private buckets = new Map<string, Map<string, S3Object>>();
  private bucketCreationDates = new Map<string, Date>();
  private bucketTypes = new Map<string, BucketType>();
  private bucketLifecycleConfigurations = new Map<string, string>();
  private multipartUploads = new Map<string, MultipartUpload>();
  private multipartUploadsByBucket = new Map<string, Set<string>>();
  spy?: MessageSpy;
  persistence?: S3PersistenceProvider;
  relaxedRules?: { disableMinCopySourceSize?: boolean };

  createBucket(name: string, type?: BucketType): void {
    if (!this.buckets.has(name)) {
      this.validateBucketName(name);
      const creationDate = new Date();
      const bucketType = type ?? "general-purpose";
      this.buckets.set(name, new Map());
      this.bucketCreationDates.set(name, creationDate);
      this.bucketTypes.set(name, bucketType);
      this.persistence?.insertBucket(name, creationDate, bucketType);
    }
  }

  setBucketCreationDate(name: string, date: Date): void {
    this.bucketCreationDates.set(name, date);
  }

  restoreObject(bucket: string, obj: S3Object): void {
    const objects = this.buckets.get(bucket);
    if (objects) {
      objects.set(obj.key, obj);
    }
  }

  restoreMultipartUpload(upload: MultipartUpload): void {
    this.multipartUploads.set(upload.uploadId, upload);
    let bucketUploads = this.multipartUploadsByBucket.get(upload.bucket);
    if (!bucketUploads) {
      bucketUploads = new Set();
      this.multipartUploadsByBucket.set(upload.bucket, bucketUploads);
    }
    bucketUploads.add(upload.uploadId);
  }

  getBucketType(name: string): BucketType | undefined {
    return this.bucketTypes.get(name);
  }

  putBucketLifecycleConfiguration(name: string, config: string): void {
    this.bucketLifecycleConfigurations.set(name, config);
  }

  getBucketLifecycleConfiguration(name: string): string | undefined {
    return this.bucketLifecycleConfigurations.get(name);
  }

  deleteBucketLifecycleConfiguration(name: string): void {
    this.bucketLifecycleConfigurations.delete(name);
  }

  private validateBucketName(name: string): void {
    if (name.length < 3 || name.length > 63) {
      throw new S3Error("InvalidBucketName", `The specified bucket is not valid: ${name}`, 400);
    }
    if (/[A-Z]/.test(name)) {
      throw new S3Error("InvalidBucketName", `The specified bucket is not valid: ${name}`, 400);
    }
    if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) {
      throw new S3Error("InvalidBucketName", `The specified bucket is not valid: ${name}`, 400);
    }
    if (/[^a-z0-9.-]/.test(name)) {
      throw new S3Error("InvalidBucketName", `The specified bucket is not valid: ${name}`, 400);
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
      throw new S3Error("InvalidBucketName", `The specified bucket is not valid: ${name}`, 400);
    }
    if (/\.\./.test(name) || /\.-/.test(name) || /-\./.test(name)) {
      throw new S3Error("InvalidBucketName", `The specified bucket is not valid: ${name}`, 400);
    }
  }

  deleteBucket(name: string): void {
    const objects = this.buckets.get(name);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${name}`, 404);
    }
    // Check for in-progress multipart uploads in this bucket (O(1) via index)
    const bucketUploads = this.multipartUploadsByBucket.get(name);
    if (bucketUploads && bucketUploads.size > 0) {
      throw new S3Error(
        "BucketNotEmpty",
        "The bucket you tried to delete is not empty. You must delete all versions in the bucket.",
        409,
      );
    }
    if (objects.size > 0) {
      throw new S3Error("BucketNotEmpty", "The bucket you tried to delete is not empty.", 409);
    }
    this.buckets.delete(name);
    this.bucketCreationDates.delete(name);
    this.bucketTypes.delete(name);
    this.bucketLifecycleConfigurations.delete(name);
    this.persistence?.deleteBucket(name);
  }

  hasBucket(name: string): boolean {
    return this.buckets.has(name);
  }

  listBuckets(): { name: string; creationDate: Date }[] {
    const result: { name: string; creationDate: Date }[] = [];
    for (const [name] of this.buckets) {
      result.push({
        name,
        creationDate: this.bucketCreationDates.get(name) ?? new Date(),
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  putObject(
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
    const objects = this.buckets.get(bucket);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }

    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    const obj: S3Object = {
      key,
      body,
      contentType: contentType ?? "application/octet-stream",
      contentLength: body.length,
      etag,
      lastModified: new Date(),
      metadata: metadata ?? {},
      ...(systemMetadata?.contentLanguage && { contentLanguage: systemMetadata.contentLanguage }),
      ...(systemMetadata?.contentDisposition && {
        contentDisposition: systemMetadata.contentDisposition,
      }),
      ...(systemMetadata?.cacheControl && { cacheControl: systemMetadata.cacheControl }),
      ...(systemMetadata?.contentEncoding && { contentEncoding: systemMetadata.contentEncoding }),
      ...(checksumData && {
        checksumAlgorithm: checksumData.algorithm,
        checksumValue: checksumData.value,
        checksumType: checksumData.type,
        ...(checksumData.partChecksums && { partChecksums: checksumData.partChecksums }),
      }),
    };

    this.persistence?.upsertObject(bucket, obj);

    // When persistence is active, keep only metadata in memory — body is read on demand
    if (this.persistence) {
      objects.set(key, { ...obj, body: Buffer.alloc(0) });
    } else {
      objects.set(key, obj);
    }

    if (this.spy) {
      this.spy.addMessage({
        service: "s3",
        bucket,
        key,
        status: "uploaded",
        timestamp: Date.now(),
      });
    }

    return obj;
  }

  getObject(bucket: string, key: string): S3Object {
    const objects = this.buckets.get(bucket);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }

    const obj = objects.get(key);
    if (!obj) {
      throw new S3Error("NoSuchKey", `The specified key does not exist.`, 404, `/${bucket}/${key}`);
    }

    if (this.spy) {
      this.spy.addMessage({
        service: "s3",
        bucket,
        key,
        status: "downloaded",
        timestamp: Date.now(),
      });
    }

    // On-demand body loading: when persistence is active and body is empty, read from persistence
    if (this.persistence && obj.body.length === 0 && obj.contentLength > 0) {
      const body = this.persistence.readBody(bucket, key);
      return { ...obj, body };
    }

    return obj;
  }

  deleteObject(bucket: string, key: string): void {
    const objects = this.buckets.get(bucket);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }

    if (this.spy && objects.has(key)) {
      this.spy.addMessage({
        service: "s3",
        bucket,
        key,
        status: "deleted",
        timestamp: Date.now(),
      });
    }

    objects.delete(key);
    this.persistence?.deleteObject(bucket, key);
  }

  headObject(bucket: string, key: string): S3Object {
    const objects = this.buckets.get(bucket);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }

    const obj = objects.get(key);
    if (!obj) {
      throw new S3Error("NoSuchKey", `The specified key does not exist.`, 404, `/${bucket}/${key}`);
    }

    return obj;
  }

  listObjects(
    bucket: string,
    options?: {
      prefix?: string;
      delimiter?: string;
      maxKeys?: number;
      startAfter?: string;
      marker?: string;
    },
  ): { objects: S3Object[]; commonPrefixes: string[]; isTruncated: boolean } {
    const objectsMap = this.buckets.get(bucket);
    if (!objectsMap) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }

    const prefix = options?.prefix ?? "";
    const delimiter = options?.delimiter;
    const maxKeys = options?.maxKeys ?? 1000;
    const startAfter = options?.startAfter ?? options?.marker ?? "";

    // Get all keys sorted lexicographically
    const allObjects = Array.from(objectsMap.values())
      .filter((obj) => obj.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));

    const result: S3Object[] = [];
    const commonPrefixSet = new Set<string>();
    let count = 0;
    let isTruncated = false;

    for (const obj of allObjects) {
      if (startAfter && obj.key <= startAfter) continue;

      if (delimiter) {
        const rest = obj.key.slice(prefix.length);
        const delimIdx = rest.indexOf(delimiter);
        if (delimIdx >= 0) {
          const commonPrefix = prefix + rest.slice(0, delimIdx + delimiter.length);
          // Skip common prefixes at or before the marker
          if (startAfter && commonPrefix <= startAfter) continue;
          if (!commonPrefixSet.has(commonPrefix)) {
            if (count >= maxKeys) {
              isTruncated = true;
              break;
            }
            commonPrefixSet.add(commonPrefix);
            count++;
          }
          continue;
        }
      }

      if (count >= maxKeys) {
        isTruncated = true;
        break;
      }
      result.push(obj);
      count++;
    }

    return {
      objects: result,
      commonPrefixes: Array.from(commonPrefixSet).sort(),
      isTruncated,
    };
  }

  renameObject(bucket: string, sourceKey: string, destKey: string): void {
    const objects = this.buckets.get(bucket);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }

    const bucketType = this.bucketTypes.get(bucket);
    if (bucketType !== "directory") {
      throw new S3Error(
        "InvalidRequest",
        "RenameObject is only supported for directory buckets.",
        400,
      );
    }

    const obj = objects.get(sourceKey);
    if (!obj) {
      throw new S3Error(
        "NoSuchKey",
        `The specified key does not exist.`,
        404,
        `/${bucket}/${sourceKey}`,
      );
    }

    // Move: set at destKey, delete sourceKey. Preserve all metadata, ETag, lastModified.
    obj.key = destKey;
    objects.set(destKey, obj);
    if (sourceKey !== destKey) {
      objects.delete(sourceKey);
    }
    this.persistence?.renameObject(bucket, sourceKey, destKey);

    if (this.spy) {
      this.spy.addMessage({
        service: "s3",
        bucket,
        key: destKey,
        status: "renamed",
        timestamp: Date.now(),
      });
    }
  }

  deleteObjects(bucket: string, keys: string[]): string[] {
    const deleted: string[] = [];
    for (const key of keys) {
      this.deleteObject(bucket, key);
      deleted.push(key);
    }
    return deleted;
  }

  // --- Multipart Upload ---

  createMultipartUpload(
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
    if (!this.buckets.has(bucket)) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }

    const uploadId = randomUUID();
    const upload: MultipartUpload = {
      uploadId,
      bucket,
      key,
      contentType: contentType ?? "application/octet-stream",
      metadata: metadata ?? {},
      parts: new Map(),
      initiated: new Date(),
      ...(systemMetadata?.contentLanguage && { contentLanguage: systemMetadata.contentLanguage }),
      ...(systemMetadata?.contentDisposition && {
        contentDisposition: systemMetadata.contentDisposition,
      }),
      ...(systemMetadata?.cacheControl && { cacheControl: systemMetadata.cacheControl }),
      ...(systemMetadata?.contentEncoding && { contentEncoding: systemMetadata.contentEncoding }),
      ...(checksumAlgorithm && { checksumAlgorithm }),
    };
    this.multipartUploads.set(uploadId, upload);
    this.persistence?.insertMultipartUpload(upload);

    let bucketUploads = this.multipartUploadsByBucket.get(bucket);
    if (!bucketUploads) {
      bucketUploads = new Set();
      this.multipartUploadsByBucket.set(bucket, bucketUploads);
    }
    bucketUploads.add(uploadId);

    return uploadId;
  }

  uploadPart(
    uploadId: string,
    partNumber: number,
    body: Buffer,
    checksumValue?: string,
  ): { etag: string; checksumValue?: string } {
    const upload = this.multipartUploads.get(uploadId);
    if (!upload) {
      throw new S3Error(
        "NoSuchUpload",
        "The specified multipart upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.",
        404,
      );
    }

    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    const part = {
      partNumber,
      body,
      etag,
      lastModified: new Date(),
      ...(checksumValue && { checksumValue }),
    };
    upload.parts.set(partNumber, part);
    this.persistence?.upsertMultipartPart(uploadId, part);

    return { etag, checksumValue };
  }

  completeMultipartUpload(
    uploadId: string,
    partSpecs: { partNumber: number; etag: string }[],
  ): S3Object {
    const upload = this.multipartUploads.get(uploadId);
    if (!upload) {
      throw new S3Error(
        "NoSuchUpload",
        "The specified multipart upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.",
        404,
      );
    }

    const objects = this.buckets.get(upload.bucket);
    if (!objects) {
      throw new S3Error(
        "NoSuchBucket",
        `The specified bucket does not exist: ${upload.bucket}`,
        404,
      );
    }

    // Validate parts are in ascending order
    for (let i = 1; i < partSpecs.length; i++) {
      if (partSpecs[i].partNumber <= partSpecs[i - 1].partNumber) {
        throw new S3Error(
          "InvalidPartOrder",
          "The list of parts was not in ascending order. The parts list must be specified in order by part number.",
          400,
        );
      }
    }

    // Validate all specified parts exist and ETags match, collect buffers and sizes in one pass
    const orderedParts: Buffer[] = [];
    const partDigests: Buffer[] = [];
    const partSizes: number[] = [];
    const MIN_PART_SIZE = 5 * 1024 * 1024;
    for (let i = 0; i < partSpecs.length; i++) {
      const spec = partSpecs[i];
      const part = upload.parts.get(spec.partNumber);
      if (!part) {
        throw new S3Error(
          "InvalidPart",
          `One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.`,
          400,
        );
      }
      // Compare ETags (strip quotes for comparison)
      const specEtag = spec.etag.replaceAll('"', "");
      const partEtag = part.etag.replaceAll('"', "");
      if (specEtag !== partEtag) {
        throw new S3Error(
          "InvalidPart",
          `One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.`,
          400,
        );
      }
      // Validate non-last parts are >= 5 MiB (AWS enforces at CompleteMultipartUpload time)
      if (i < partSpecs.length - 1 && part.body.length < MIN_PART_SIZE) {
        throw new S3Error(
          "EntityTooSmall",
          "Your proposed upload is smaller than the minimum allowed size",
          400,
        );
      }
      orderedParts.push(part.body);
      partDigests.push(createHash("md5").update(part.body).digest());
      partSizes.push(part.body.length);
    }

    // Collect per-part checksums before clearing parts
    let checksumFields: Partial<
      Pick<S3Object, "checksumAlgorithm" | "checksumValue" | "checksumType" | "partChecksums">
    > = {};
    if (upload.checksumAlgorithm) {
      const partChecksumsArr: string[] = [];
      for (const spec of partSpecs) {
        const part = upload.parts.get(spec.partNumber)!;
        if (part.checksumValue) {
          partChecksumsArr.push(part.checksumValue);
        }
      }
      if (partChecksumsArr.length > 0) {
        checksumFields = {
          checksumAlgorithm: upload.checksumAlgorithm,
          checksumValue: computeCompositeChecksum(upload.checksumAlgorithm, partChecksumsArr),
          checksumType: "COMPOSITE",
          partChecksums: partChecksumsArr,
        };
      }
    }

    // Release individual part buffers before concat so GC can reclaim them sooner
    upload.parts.clear();

    // Concatenate all parts
    const body = Buffer.concat(orderedParts);
    orderedParts.length = 0; // release references to individual buffers

    // Build part boundaries for partNumber retrieval
    let offset = 0;
    const partBoundaries: Array<{ partNumber: number; offset: number; length: number }> = [];
    for (let i = 0; i < partSpecs.length; i++) {
      partBoundaries.push({ partNumber: partSpecs[i].partNumber, offset, length: partSizes[i] });
      offset += partSizes[i];
    }

    // Calculate multipart ETag: MD5(concat of binary MD5 digests) + "-" + part count
    const combinedDigest = createHash("md5").update(Buffer.concat(partDigests)).digest("hex");
    const etag = `"${combinedDigest}-${partSpecs.length}"`;

    const obj: S3Object = {
      key: upload.key,
      body,
      contentType: upload.contentType,
      contentLength: body.length,
      etag,
      lastModified: new Date(),
      metadata: upload.metadata,
      parts: partBoundaries,
      ...(upload.contentLanguage && { contentLanguage: upload.contentLanguage }),
      ...(upload.contentDisposition && { contentDisposition: upload.contentDisposition }),
      ...(upload.cacheControl && { cacheControl: upload.cacheControl }),
      ...(upload.contentEncoding && { contentEncoding: upload.contentEncoding }),
      ...checksumFields,
    };

    this.persistence?.completeMultipartUpload(uploadId, upload.bucket, obj);

    // When persistence is active, keep only metadata in memory — body is read on demand
    if (this.persistence) {
      objects.set(upload.key, { ...obj, body: Buffer.alloc(0) });
    } else {
      objects.set(upload.key, obj);
    }
    this.multipartUploads.delete(uploadId);
    this.multipartUploadsByBucket.get(upload.bucket)?.delete(uploadId);

    if (this.spy) {
      this.spy.addMessage({
        service: "s3",
        bucket: upload.bucket,
        key: upload.key,
        status: "uploaded",
        timestamp: Date.now(),
      });
    }

    return obj;
  }

  abortMultipartUpload(uploadId: string): void {
    const upload = this.multipartUploads.get(uploadId);
    if (!upload) {
      throw new S3Error(
        "NoSuchUpload",
        "The specified multipart upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.",
        404,
      );
    }

    this.multipartUploads.delete(uploadId);
    this.multipartUploadsByBucket.get(upload.bucket)?.delete(uploadId);
    this.persistence?.deleteMultipartUpload(uploadId);
  }

  /** Remove all objects from a single bucket and abort its multipart uploads. No-op if the bucket does not exist. */
  emptyBucket(name: string): void {
    const objects = this.buckets.get(name);
    if (!objects) return;
    objects.clear();
    this.persistence?.deleteObjectsByBucket(name);
    const bucketUploads = this.multipartUploadsByBucket.get(name);
    if (bucketUploads) {
      for (const uploadId of bucketUploads) {
        this.multipartUploads.delete(uploadId);
        this.persistence?.deleteMultipartUpload(uploadId);
      }
      bucketUploads.clear();
    }
  }

  /** Clear all objects from all buckets and abort all multipart uploads, but keep the buckets. */
  clearObjects(): void {
    for (const objects of this.buckets.values()) {
      objects.clear();
    }
    this.multipartUploads.clear();
    this.multipartUploadsByBucket.clear();
  }

  purgeAll(): void {
    this.buckets.clear();
    this.bucketCreationDates.clear();
    this.bucketTypes.clear();
    this.bucketLifecycleConfigurations.clear();
    this.multipartUploads.clear();
    this.multipartUploadsByBucket.clear();
  }
}
