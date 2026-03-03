import { describe, it, expect, beforeEach, afterEach, onTestFinished } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFauxqs } from "../../src/app.js";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  ListBucketsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "fauxqs-file-s3-"));
}

function makeS3Client(port: number): S3Client {
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
  });
  onTestFinished(() => client.destroy());
  return client;
}

function makeSqsClient(port: number): SQSClient {
  const client = new SQSClient({
    endpoint: `http://127.0.0.1:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  onTestFinished(() => client.destroy());
  return client;
}

describe("File-based S3 Persistence", () => {
  let s3StorageDir: string;

  beforeEach(() => {
    s3StorageDir = createTempDir();
  });

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(s3StorageDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it("S3 objects survive restart via s3StorageDir", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "file-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "file-bucket",
        Key: "hello.txt",
        Body: "file persistence works",
        ContentType: "text/plain",
      }),
    );

    await server.stop();

    // Restart with same s3StorageDir
    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets?.some((b) => b.Name === "file-bucket")).toBe(true);

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "file-bucket", Key: "hello.txt" }),
    );
    expect(await obj.Body!.transformToString()).toBe("file persistence works");
    expect(obj.ContentType).toBe("text/plain");

    await server.stop();
  });

  it("multipart uploads survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "mp-file-bucket" }));

    const create = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: "mp-file-bucket",
        Key: "large.bin",
        ContentType: "application/octet-stream",
      }),
    );
    const uploadId = create.UploadId!;

    const partBody = Buffer.alloc(5 * 1024 * 1024, "B");
    const upload = await s3.send(
      new UploadPartCommand({
        Bucket: "mp-file-bucket",
        Key: "large.bin",
        UploadId: uploadId,
        PartNumber: 1,
        Body: partBody,
      }),
    );

    await server.stop();

    // Restart and complete multipart upload
    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const complete = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: "mp-file-bucket",
        Key: "large.bin",
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [{ PartNumber: 1, ETag: upload.ETag }],
        },
      }),
    );
    expect(complete.Key).toBe("large.bin");

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "mp-file-bucket", Key: "large.bin" }),
    );
    expect(obj.ContentLength).toBe(5 * 1024 * 1024);

    await server.stop();
  });

  it("object metadata and system metadata survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "meta-file-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "meta-file-bucket",
        Key: "meta.txt",
        Body: "metadata test",
        ContentType: "text/plain",
        Metadata: { "x-custom-header": "custom-value" },
        ContentLanguage: "en-US",
        ContentDisposition: 'attachment; filename="meta.txt"',
        CacheControl: "max-age=3600",
        ContentEncoding: "identity",
      }),
    );

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "meta-file-bucket", Key: "meta.txt" }),
    );
    expect(obj.Metadata?.["x-custom-header"]).toBe("custom-value");
    expect(obj.ContentLanguage).toBe("en-US");
    expect(obj.ContentDisposition).toBe('attachment; filename="meta.txt"');
    expect(obj.CacheControl).toBe("max-age=3600");
    expect(obj.ContentEncoding).toBe("identity");

    await server.stop();
  });

  it("directory bucket type survives restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });

    server.createBucket("dir-file-bucket--useast1-az1--x-s3", { type: "directory" });

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    const s3 = makeS3Client(server.port);

    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets?.some((b) => b.Name === "dir-file-bucket--useast1-az1--x-s3")).toBe(true);

    await server.stop();
  });

  it("bucket and object deletion persist", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "del-file-bucket" }));
    await s3.send(
      new PutObjectCommand({ Bucket: "del-file-bucket", Key: "del.txt", Body: "delete me" }),
    );
    await s3.send(new DeleteObjectCommand({ Bucket: "del-file-bucket", Key: "del.txt" }));
    await s3.send(new DeleteBucketCommand({ Bucket: "del-file-bucket" }));

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets?.some((b) => b.Name === "del-file-bucket")).toBe(false);

    await server.stop();
  });

  it("files are inspectable at expected filesystem paths", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "inspect-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "inspect-bucket",
        Key: "photos/vacation.jpg",
        Body: "fake image data",
        ContentType: "image/jpeg",
      }),
    );

    await server.stop();

    // Check filesystem layout
    const bucketMeta = join(s3StorageDir, "buckets", "inspect-bucket", ".bucket.json");
    expect(existsSync(bucketMeta)).toBe(true);
    const meta = JSON.parse(readFileSync(bucketMeta, "utf-8"));
    expect(meta.name).toBe("inspect-bucket");

    const dataPath = join(
      s3StorageDir,
      "buckets",
      "inspect-bucket",
      "objects",
      "photos",
      "vacation.jpg.data",
    );
    expect(existsSync(dataPath)).toBe(true);
    expect(readFileSync(dataPath, "utf-8")).toBe("fake image data");

    const objMeta = join(
      s3StorageDir,
      "buckets",
      "inspect-bucket",
      "objects",
      "photos",
      "vacation.jpg.meta.json",
    );
    expect(existsSync(objMeta)).toBe(true);
    const objMetaParsed = JSON.parse(readFileSync(objMeta, "utf-8"));
    expect(objMetaParsed.key).toBe("photos/vacation.jpg");
    expect(objMetaParsed.contentType).toBe("image/jpeg");
  });

  it("mixed mode: dataDir for SQS/SNS, s3StorageDir for S3", async () => {
    const dataDir = createTempDir();
    onTestFinished(async () => {
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    });

    let server = await startFauxqs({ port: 0, logger: false, dataDir, s3StorageDir });
    let sqs = makeSqsClient(server.port);
    let s3 = makeS3Client(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "mixed-q" }));
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/mixed-q`,
        MessageBody: "sqs message",
      }),
    );

    await s3.send(new CreateBucketCommand({ Bucket: "mixed-bucket" }));
    await s3.send(
      new PutObjectCommand({ Bucket: "mixed-bucket", Key: "s3.txt", Body: "s3 data" }),
    );

    await server.stop();

    // Restart with both
    server = await startFauxqs({ port: 0, logger: false, dataDir, s3StorageDir });
    sqs = makeSqsClient(server.port);
    s3 = makeS3Client(server.port);

    // SQS should survive (via SQLite)
    const recv = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/mixed-q`,
      }),
    );
    expect(recv.Messages).toHaveLength(1);
    expect(recv.Messages![0].Body).toBe("sqs message");

    // S3 should survive (via files)
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "mixed-bucket", Key: "s3.txt" }),
    );
    expect(await obj.Body!.transformToString()).toBe("s3 data");

    // Verify S3 is stored as files, not in SQLite
    const s3DataPath = join(s3StorageDir, "buckets", "mixed-bucket", "objects", "s3.txt.data");
    expect(existsSync(s3DataPath)).toBe(true);

    await server.stop();
  });

  it("s3-only mode: only s3StorageDir, no dataDir", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "s3only-bucket" }));
    await s3.send(
      new PutObjectCommand({ Bucket: "s3only-bucket", Key: "data.bin", Body: "binary data" }),
    );

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "s3only-bucket", Key: "data.bin" }),
    );
    expect(await obj.Body!.transformToString()).toBe("binary data");

    await server.stop();
  });

  it("reset() clears S3 file storage", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "reset-file-bucket" }));
    await s3.send(
      new PutObjectCommand({ Bucket: "reset-file-bucket", Key: "clear.txt", Body: "reset me" }),
    );

    server.reset();
    await server.stop();

    // Restart — bucket should exist but object should be gone
    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets?.some((b) => b.Name === "reset-file-bucket")).toBe(true);

    await expect(
      s3.send(new GetObjectCommand({ Bucket: "reset-file-bucket", Key: "clear.txt" })),
    ).rejects.toThrow();

    await server.stop();
  });

  it("purgeAll() clears all S3 file storage", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });

    server.createBucket("purge-file-bucket");

    server.purgeAll();
    await server.stop();

    // Restart — nothing should exist
    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    const s3 = makeS3Client(server.port);

    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets ?? []).toHaveLength(0);

    await server.stop();
  });

  it("headObject works without loading body from persistence", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "head-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "head-bucket",
        Key: "head.txt",
        Body: "head test content",
        ContentType: "text/plain",
      }),
    );

    await server.stop();

    // Restart — headObject should work without reading the body file
    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: "head-bucket", Key: "head.txt" }),
    );
    expect(head.ContentType).toBe("text/plain");
    expect(head.ContentLength).toBe(17); // "head test content".length

    await server.stop();
  });

  it("S3 keys with slashes create nested directories", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "nested-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "nested-bucket",
        Key: "a/b/c/deep.txt",
        Body: "deep nested",
      }),
    );

    await server.stop();

    // Verify nested directory structure
    const dataPath = join(
      s3StorageDir,
      "buckets",
      "nested-bucket",
      "objects",
      "a",
      "b",
      "c",
      "deep.txt.data",
    );
    expect(existsSync(dataPath)).toBe(true);

    // Restart and verify retrieval
    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "nested-bucket", Key: "a/b/c/deep.txt" }),
    );
    expect(await obj.Body!.transformToString()).toBe("deep nested");

    await server.stop();
  });

  it("getObject returns correct body in same session (on-demand loading)", async () => {
    const server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    const s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "same-session-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "same-session-bucket",
        Key: "immediate.txt",
        Body: "read me back immediately",
      }),
    );

    // getObject in the SAME session — body is empty in Map, must lazy-load from persistence
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "same-session-bucket", Key: "immediate.txt" }),
    );
    expect(await obj.Body!.transformToString()).toBe("read me back immediately");

    await server.stop();
  });

  it("renameObject persists across restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    server.createBucket("rename-file-bucket", { type: "directory" });

    await s3.send(
      new PutObjectCommand({
        Bucket: "rename-file-bucket",
        Key: "old-name.txt",
        Body: "rename me",
        ContentType: "text/plain",
      }),
    );

    // Rename via raw fetch (SDK doesn't support RenameObject)
    const res = await fetch(
      `http://127.0.0.1:${server.port}/rename-file-bucket/new-name.txt?renameObject`,
      {
        method: "PUT",
        headers: { "x-amz-rename-source": "old-name.txt" },
      },
    );
    expect(res.status).toBe(200);

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "rename-file-bucket", Key: "new-name.txt" }),
    );
    expect(await obj.Body!.transformToString()).toBe("rename me");

    await expect(
      s3.send(new GetObjectCommand({ Bucket: "rename-file-bucket", Key: "old-name.txt" })),
    ).rejects.toThrow();

    await server.stop();
  });

  it("emptyBucket clears files but keeps the bucket", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "empty-file-bucket" }));
    await s3.send(
      new PutObjectCommand({ Bucket: "empty-file-bucket", Key: "a.txt", Body: "aaa" }),
    );
    await s3.send(
      new PutObjectCommand({ Bucket: "empty-file-bucket", Key: "b.txt", Body: "bbb" }),
    );

    server.emptyBucket("empty-file-bucket");
    await server.stop();

    // Restart — bucket exists but objects are gone
    server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    s3 = makeS3Client(server.port);

    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets?.some((b) => b.Name === "empty-file-bucket")).toBe(true);

    await expect(
      s3.send(new GetObjectCommand({ Bucket: "empty-file-bucket", Key: "a.txt" })),
    ).rejects.toThrow();
    await expect(
      s3.send(new GetObjectCommand({ Bucket: "empty-file-bucket", Key: "b.txt" })),
    ).rejects.toThrow();

    await server.stop();
  });

  it("deleting objects cleans up empty parent directories", async () => {
    let server = await startFauxqs({ port: 0, logger: false, s3StorageDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "cleanup-bucket" }));
    await s3.send(
      new PutObjectCommand({ Bucket: "cleanup-bucket", Key: "a/b/only.txt", Body: "data" }),
    );

    // Verify intermediate dirs exist
    const bDir = join(s3StorageDir, "buckets", "cleanup-bucket", "objects", "a", "b");
    expect(existsSync(bDir)).toBe(true);

    await s3.send(new DeleteObjectCommand({ Bucket: "cleanup-bucket", Key: "a/b/only.txt" }));

    // Empty parent directories should be cleaned up
    expect(existsSync(bDir)).toBe(false);
    const aDir = join(s3StorageDir, "buckets", "cleanup-bucket", "objects", "a");
    expect(existsSync(aDir)).toBe(false);

    // The objects dir itself should still exist
    const objectsDir = join(s3StorageDir, "buckets", "cleanup-bucket", "objects");
    expect(existsSync(objectsDir)).toBe(true);

    await server.stop();
  });
});
