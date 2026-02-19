import { createHash } from "node:crypto";
import { S3Error } from "../common/errors.ts";
import type { S3Object } from "./s3Types.ts";

export class S3Store {
  private buckets = new Map<string, Map<string, S3Object>>();

  createBucket(name: string): void {
    if (!this.buckets.has(name)) {
      this.buckets.set(name, new Map());
    }
  }

  deleteBucket(name: string): void {
    const objects = this.buckets.get(name);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${name}`, 404);
    }
    if (objects.size > 0) {
      throw new S3Error("BucketNotEmpty", "The bucket you tried to delete is not empty.", 409);
    }
    this.buckets.delete(name);
  }

  hasBucket(name: string): boolean {
    return this.buckets.has(name);
  }

  putObject(bucket: string, key: string, body: Buffer, contentType?: string, metadata?: Record<string, string>): S3Object {
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
    options?: { prefix?: string; delimiter?: string; maxKeys?: number; startAfter?: string; marker?: string },
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
}
