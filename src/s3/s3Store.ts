import { createHash, randomUUID } from "node:crypto";
import { S3Error } from "../common/errors.ts";
import type { S3Object, MultipartUpload } from "./s3Types.ts";

export class S3Store {
  private buckets = new Map<string, Map<string, S3Object>>();
  private bucketCreationDates = new Map<string, Date>();
  private multipartUploads = new Map<string, MultipartUpload>();

  createBucket(name: string): void {
    if (!this.buckets.has(name)) {
      this.buckets.set(name, new Map());
      this.bucketCreationDates.set(name, new Date());
    }
  }

  deleteBucket(name: string): void {
    const objects = this.buckets.get(name);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${name}`, 404);
    }
    // Check for in-progress multipart uploads in this bucket
    for (const upload of this.multipartUploads.values()) {
      if (upload.bucket === name) {
        throw new S3Error(
          "BucketNotEmpty",
          "The bucket you tried to delete is not empty. You must delete all versions in the bucket.",
          409,
        );
      }
    }
    if (objects.size > 0) {
      throw new S3Error("BucketNotEmpty", "The bucket you tried to delete is not empty.", 409);
    }
    this.buckets.delete(name);
    this.bucketCreationDates.delete(name);
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
    };

    objects.set(key, obj);
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

    return obj;
  }

  deleteObject(bucket: string, key: string): void {
    const objects = this.buckets.get(bucket);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }
    objects.delete(key);
  }

  headObject(bucket: string, key: string): S3Object {
    return this.getObject(bucket, key);
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
  ): string {
    if (!this.buckets.has(bucket)) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }

    const uploadId = randomUUID();
    this.multipartUploads.set(uploadId, {
      uploadId,
      bucket,
      key,
      contentType: contentType ?? "application/octet-stream",
      metadata: metadata ?? {},
      parts: new Map(),
      initiated: new Date(),
    });

    return uploadId;
  }

  uploadPart(uploadId: string, partNumber: number, body: Buffer): string {
    const upload = this.multipartUploads.get(uploadId);
    if (!upload) {
      throw new S3Error(
        "NoSuchUpload",
        "The specified multipart upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.",
        404,
      );
    }

    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    upload.parts.set(partNumber, {
      partNumber,
      body,
      etag,
      lastModified: new Date(),
    });

    return etag;
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

    // Validate all specified parts exist and ETags match
    const orderedParts: Buffer[] = [];
    const partDigests: Buffer[] = [];
    for (const spec of partSpecs) {
      const part = upload.parts.get(spec.partNumber);
      if (!part) {
        throw new S3Error(
          "InvalidPart",
          `One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.`,
          400,
        );
      }
      // Compare ETags (strip quotes for comparison)
      const specEtag = spec.etag.replace(/"/g, "");
      const partEtag = part.etag.replace(/"/g, "");
      if (specEtag !== partEtag) {
        throw new S3Error(
          "InvalidPart",
          `One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.`,
          400,
        );
      }
      orderedParts.push(part.body);
      partDigests.push(createHash("md5").update(part.body).digest());
    }

    // Concatenate all parts
    const body = Buffer.concat(orderedParts);

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
    };

    objects.set(upload.key, obj);
    this.multipartUploads.delete(uploadId);

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
  }
}
