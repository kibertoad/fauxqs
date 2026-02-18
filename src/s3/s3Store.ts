import { createHash } from "node:crypto";
import { S3Error } from "../common/errors.js";
import type { S3Object } from "./s3Types.js";

export class S3Store {
  private buckets = new Map<string, Map<string, S3Object>>();

  createBucket(name: string): void {
    if (!this.buckets.has(name)) {
      this.buckets.set(name, new Map());
    }
  }

  hasBucket(name: string): boolean {
    return this.buckets.has(name);
  }

  putObject(bucket: string, key: string, body: Buffer, contentType?: string): S3Object {
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
    if (objects) {
      objects.delete(key);
    }
  }

  headObject(bucket: string, key: string): S3Object {
    return this.getObject(bucket, key);
  }

  listObjects(bucket: string): S3Object[] {
    const objects = this.buckets.get(bucket);
    if (!objects) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }
    return Array.from(objects.values());
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
