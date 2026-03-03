import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  rmSync,
  rmdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, dirname, sep } from "node:path";
import type { S3PersistenceProvider } from "./s3Persistence.ts";
import type { S3Store, BucketType } from "./s3Store.ts";
import type { S3Object, MultipartUpload, MultipartPart, ChecksumAlgorithm } from "./s3Types.ts";

/**
 * Encode an S3 key into a filesystem-safe relative path.
 * Slashes become directory separators; unsafe filesystem chars are percent-encoded.
 * The original key is always stored in .meta.json so load never depends on path decoding.
 */
function encodeKeyToPath(key: string): string {
  // Percent-encode chars that are unsafe on common filesystems (Windows + Unix).
  // We do NOT encode '/' — those become directory separators.
  // eslint-disable-next-line no-control-regex
  const encoded = key.replace(/[<>:"|?*\\%\x00-\x1f]/g, (ch) => {
    return "%" + ch.charCodeAt(0).toString(16).padStart(2, "0");
  });
  // Convert forward slashes to platform path separators
  return encoded.split("/").join(sep);
}

interface ObjectMeta {
  key: string;
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified: string;
  metadata: Record<string, string>;
  contentLanguage?: string;
  contentDisposition?: string;
  cacheControl?: string;
  contentEncoding?: string;
  parts?: Array<{ partNumber: number; offset: number; length: number }>;
  checksumAlgorithm?: string;
  checksumValue?: string;
  checksumType?: string;
  partChecksums?: string[];
}

interface BucketMeta {
  name: string;
  creationDate: string;
  type: BucketType;
}

interface UploadMeta {
  uploadId: string;
  bucket: string;
  key: string;
  contentType: string;
  metadata: Record<string, string>;
  initiated: string;
  contentLanguage?: string;
  contentDisposition?: string;
  cacheControl?: string;
  contentEncoding?: string;
  checksumAlgorithm?: string;
}

interface PartMeta {
  partNumber: number;
  etag: string;
  lastModified: string;
  checksumValue?: string;
}

export class FileS3Persistence implements S3PersistenceProvider {
  private baseDir: string;
  private bucketsDir: string;
  private multipartDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.bucketsDir = join(baseDir, "buckets");
    this.multipartDir = join(baseDir, "_multipart");
    mkdirSync(this.bucketsDir, { recursive: true });
    mkdirSync(this.multipartDir, { recursive: true });
  }

  // ── Bucket ops ──

  insertBucket(name: string, creationDate: Date, type: BucketType): void {
    const bucketDir = join(this.bucketsDir, name);
    mkdirSync(join(bucketDir, "objects"), { recursive: true });
    const meta: BucketMeta = { name, creationDate: creationDate.toISOString(), type };
    writeFileSync(join(bucketDir, ".bucket.json"), JSON.stringify(meta));
  }

  deleteBucket(name: string): void {
    const bucketDir = join(this.bucketsDir, name);
    if (existsSync(bucketDir)) {
      rmSync(bucketDir, { recursive: true, force: true });
    }
  }

  // ── Object ops ──

  upsertObject(bucket: string, obj: S3Object): void {
    const objectsDir = join(this.bucketsDir, bucket, "objects");
    const relPath = encodeKeyToPath(obj.key);
    const dataPath = join(objectsDir, relPath + ".data");
    const metaPath = join(objectsDir, relPath + ".meta.json");

    mkdirSync(dirname(dataPath), { recursive: true });
    writeFileSync(dataPath, obj.body);

    const meta: ObjectMeta = {
      key: obj.key,
      contentType: obj.contentType,
      contentLength: obj.contentLength,
      etag: obj.etag,
      lastModified: obj.lastModified.toISOString(),
      metadata: obj.metadata,
      ...(obj.contentLanguage && { contentLanguage: obj.contentLanguage }),
      ...(obj.contentDisposition && { contentDisposition: obj.contentDisposition }),
      ...(obj.cacheControl && { cacheControl: obj.cacheControl }),
      ...(obj.contentEncoding && { contentEncoding: obj.contentEncoding }),
      ...(obj.parts && { parts: obj.parts }),
      ...(obj.checksumAlgorithm && { checksumAlgorithm: obj.checksumAlgorithm }),
      ...(obj.checksumValue && { checksumValue: obj.checksumValue }),
      ...(obj.checksumType && { checksumType: obj.checksumType }),
      ...(obj.partChecksums && { partChecksums: obj.partChecksums }),
    };
    writeFileSync(metaPath, JSON.stringify(meta));
  }

  deleteObject(bucket: string, key: string): void {
    const objectsDir = join(this.bucketsDir, bucket, "objects");
    const relPath = encodeKeyToPath(key);
    const dataPath = join(objectsDir, relPath + ".data");
    const metaPath = join(objectsDir, relPath + ".meta.json");

    try {
      unlinkSync(dataPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(metaPath);
    } catch {
      /* ignore */
    }

    // Clean up empty parent directories up to (but not including) the objects dir
    this.cleanEmptyParents(dirname(dataPath), objectsDir);
  }

  deleteObjectsByBucket(bucket: string): void {
    const objectsDir = join(this.bucketsDir, bucket, "objects");
    if (existsSync(objectsDir)) {
      rmSync(objectsDir, { recursive: true, force: true });
      mkdirSync(objectsDir, { recursive: true });
    }
  }

  deleteAllObjects(): void {
    // Delete all objects from all buckets but keep bucket dirs and .bucket.json
    if (!existsSync(this.bucketsDir)) return;
    for (const bucketName of readdirSync(this.bucketsDir)) {
      const objectsDir = join(this.bucketsDir, bucketName, "objects");
      if (existsSync(objectsDir)) {
        rmSync(objectsDir, { recursive: true, force: true });
        mkdirSync(objectsDir, { recursive: true });
      }
    }
  }

  renameObject(bucket: string, sourceKey: string, destKey: string): void {
    const objectsDir = join(this.bucketsDir, bucket, "objects");
    const srcRel = encodeKeyToPath(sourceKey);
    const dstRel = encodeKeyToPath(destKey);

    const srcData = join(objectsDir, srcRel + ".data");
    const srcMeta = join(objectsDir, srcRel + ".meta.json");
    const dstData = join(objectsDir, dstRel + ".data");
    const dstMeta = join(objectsDir, dstRel + ".meta.json");

    mkdirSync(dirname(dstData), { recursive: true });

    // Read existing metadata and update key
    const meta: ObjectMeta = JSON.parse(readFileSync(srcMeta, "utf-8"));
    meta.key = destKey;

    renameSync(srcData, dstData);
    writeFileSync(dstMeta, JSON.stringify(meta));
    try {
      unlinkSync(srcMeta);
    } catch {
      /* ignore if same path */
    }

    this.cleanEmptyParents(dirname(srcData), objectsDir);
  }

  // ── On-demand body read ──

  readBody(bucket: string, key: string): Buffer {
    const objectsDir = join(this.bucketsDir, bucket, "objects");
    const relPath = encodeKeyToPath(key);
    const dataPath = join(objectsDir, relPath + ".data");
    return readFileSync(dataPath);
  }

  // ── Multipart ops ──

  insertMultipartUpload(upload: MultipartUpload): void {
    const uploadDir = join(this.multipartDir, upload.uploadId);
    mkdirSync(join(uploadDir, "parts"), { recursive: true });

    const meta: UploadMeta = {
      uploadId: upload.uploadId,
      bucket: upload.bucket,
      key: upload.key,
      contentType: upload.contentType,
      metadata: upload.metadata,
      initiated: upload.initiated.toISOString(),
      ...(upload.contentLanguage && { contentLanguage: upload.contentLanguage }),
      ...(upload.contentDisposition && { contentDisposition: upload.contentDisposition }),
      ...(upload.cacheControl && { cacheControl: upload.cacheControl }),
      ...(upload.contentEncoding && { contentEncoding: upload.contentEncoding }),
      ...(upload.checksumAlgorithm && { checksumAlgorithm: upload.checksumAlgorithm }),
    };
    writeFileSync(join(uploadDir, ".upload.json"), JSON.stringify(meta));
  }

  upsertMultipartPart(uploadId: string, part: MultipartPart): void {
    const partsDir = join(this.multipartDir, uploadId, "parts");
    mkdirSync(partsDir, { recursive: true });

    writeFileSync(join(partsDir, `${part.partNumber}.data`), part.body);
    const meta: PartMeta = {
      partNumber: part.partNumber,
      etag: part.etag,
      lastModified: part.lastModified.toISOString(),
      ...(part.checksumValue && { checksumValue: part.checksumValue }),
    };
    writeFileSync(join(partsDir, `${part.partNumber}.meta.json`), JSON.stringify(meta));
  }

  deleteMultipartUpload(uploadId: string): void {
    const uploadDir = join(this.multipartDir, uploadId);
    if (existsSync(uploadDir)) {
      rmSync(uploadDir, { recursive: true, force: true });
    }
  }

  completeMultipartUpload(uploadId: string, bucket: string, obj: S3Object): void {
    this.upsertObject(bucket, obj);
    this.deleteMultipartUpload(uploadId);
  }

  deleteAllMultipartUploads(): void {
    if (existsSync(this.multipartDir)) {
      rmSync(this.multipartDir, { recursive: true, force: true });
      mkdirSync(this.multipartDir, { recursive: true });
    }
  }

  // ── Startup load ──

  loadS3(s3Store: S3Store): void {
    this.loadBuckets(s3Store);
    this.loadObjects(s3Store);
    this.loadMultipartUploads(s3Store);
  }

  private loadBuckets(s3Store: S3Store): void {
    if (!existsSync(this.bucketsDir)) return;
    for (const bucketName of readdirSync(this.bucketsDir)) {
      const metaPath = join(this.bucketsDir, bucketName, ".bucket.json");
      if (!existsSync(metaPath)) continue;
      const meta: BucketMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
      s3Store.createBucket(meta.name, meta.type);
      s3Store.setBucketCreationDate(meta.name, new Date(meta.creationDate));
    }
  }

  private loadObjects(s3Store: S3Store): void {
    if (!existsSync(this.bucketsDir)) return;
    for (const bucketName of readdirSync(this.bucketsDir)) {
      const objectsDir = join(this.bucketsDir, bucketName, "objects");
      if (!existsSync(objectsDir)) continue;
      this.walkMetaFiles(objectsDir, (metaPath) => {
        const meta: ObjectMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
        const obj: S3Object = {
          key: meta.key,
          body: Buffer.alloc(0), // Metadata only — body is read on demand
          contentType: meta.contentType,
          contentLength: meta.contentLength,
          etag: meta.etag,
          lastModified: new Date(meta.lastModified),
          metadata: meta.metadata,
          ...(meta.contentLanguage && { contentLanguage: meta.contentLanguage }),
          ...(meta.contentDisposition && { contentDisposition: meta.contentDisposition }),
          ...(meta.cacheControl && { cacheControl: meta.cacheControl }),
          ...(meta.contentEncoding && { contentEncoding: meta.contentEncoding }),
          ...(meta.parts && { parts: meta.parts }),
          ...(meta.checksumAlgorithm && {
            checksumAlgorithm: meta.checksumAlgorithm as ChecksumAlgorithm,
          }),
          ...(meta.checksumValue && { checksumValue: meta.checksumValue }),
          ...(meta.checksumType && {
            checksumType: meta.checksumType as "FULL_OBJECT" | "COMPOSITE",
          }),
          ...(meta.partChecksums && { partChecksums: meta.partChecksums }),
        };
        s3Store.restoreObject(bucketName, obj);
      });
    }
  }

  private loadMultipartUploads(s3Store: S3Store): void {
    if (!existsSync(this.multipartDir)) return;
    for (const uploadId of readdirSync(this.multipartDir)) {
      const uploadMetaPath = join(this.multipartDir, uploadId, ".upload.json");
      if (!existsSync(uploadMetaPath)) continue;
      const meta: UploadMeta = JSON.parse(readFileSync(uploadMetaPath, "utf-8"));

      const upload: MultipartUpload = {
        uploadId: meta.uploadId,
        bucket: meta.bucket,
        key: meta.key,
        contentType: meta.contentType,
        metadata: meta.metadata,
        parts: new Map(),
        initiated: new Date(meta.initiated),
        ...(meta.contentLanguage && { contentLanguage: meta.contentLanguage }),
        ...(meta.contentDisposition && { contentDisposition: meta.contentDisposition }),
        ...(meta.cacheControl && { cacheControl: meta.cacheControl }),
        ...(meta.contentEncoding && { contentEncoding: meta.contentEncoding }),
        ...(meta.checksumAlgorithm && {
          checksumAlgorithm: meta.checksumAlgorithm as ChecksumAlgorithm,
        }),
      };

      // Load parts fully (they're temporary, needed for completeMultipartUpload concatenation)
      const partsDir = join(this.multipartDir, uploadId, "parts");
      if (existsSync(partsDir)) {
        for (const file of readdirSync(partsDir)) {
          if (!file.endsWith(".meta.json")) continue;
          const partMeta: PartMeta = JSON.parse(readFileSync(join(partsDir, file), "utf-8"));
          const partBody = readFileSync(join(partsDir, `${partMeta.partNumber}.data`));
          upload.parts.set(partMeta.partNumber, {
            partNumber: partMeta.partNumber,
            body: partBody,
            etag: partMeta.etag,
            lastModified: new Date(partMeta.lastModified),
            ...(partMeta.checksumValue && { checksumValue: partMeta.checksumValue }),
          });
        }
      }

      s3Store.restoreMultipartUpload(upload);
    }
  }

  // ── Helpers ──

  /** Recursively walk a directory for .meta.json files */
  private walkMetaFiles(dir: string, callback: (metaPath: string) => void): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkMetaFiles(fullPath, callback);
      } else if (entry.name.endsWith(".meta.json")) {
        callback(fullPath);
      }
    }
  }

  /** Remove empty directories up the chain, stopping at (but not including) stopAt */
  private cleanEmptyParents(dir: string, stopAt: string): void {
    let current = dir;
    while (current !== stopAt && current.startsWith(stopAt)) {
      try {
        const entries = readdirSync(current);
        if (entries.length === 0) {
          rmdirSync(current);
          current = dirname(current);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }

  /** Remove all data (buckets, objects, multipart uploads) from the storage directory. */
  purgeAll(): void {
    if (existsSync(this.bucketsDir)) {
      rmSync(this.bucketsDir, { recursive: true, force: true });
      mkdirSync(this.bucketsDir, { recursive: true });
    }
    this.deleteAllMultipartUploads();
  }

  close(): void {
    // No resources to release for file-based persistence
  }
}
