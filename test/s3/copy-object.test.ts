import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 CopyObject", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "copy-src" }));
    await s3.send(new CreateBucketCommand({ Bucket: "copy-dst" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("copies object within the same bucket", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "copy-src",
        Key: "original.txt",
        Body: "hello world",
        ContentType: "text/plain",
      }),
    );

    const result = await s3.send(
      new CopyObjectCommand({
        Bucket: "copy-src",
        Key: "copy.txt",
        CopySource: "copy-src/original.txt",
      }),
    );
    expect(result.CopyObjectResult?.ETag).toBeDefined();

    const getResult = await s3.send(
      new GetObjectCommand({ Bucket: "copy-src", Key: "copy.txt" }),
    );
    const body = await getResult.Body!.transformToString();
    expect(body).toBe("hello world");
    expect(getResult.ContentType).toBe("text/plain");
  });

  it("copies object across buckets", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "copy-src",
        Key: "cross-bucket.txt",
        Body: "cross bucket content",
      }),
    );

    await s3.send(
      new CopyObjectCommand({
        Bucket: "copy-dst",
        Key: "received.txt",
        CopySource: "copy-src/cross-bucket.txt",
      }),
    );

    const getResult = await s3.send(
      new GetObjectCommand({ Bucket: "copy-dst", Key: "received.txt" }),
    );
    const body = await getResult.Body!.transformToString();
    expect(body).toBe("cross bucket content");
  });

  it("preserves source metadata when no new metadata is provided", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "copy-src",
        Key: "with-meta.txt",
        Body: "metadata test",
        Metadata: { author: "test-user", version: "1" },
      }),
    );

    await s3.send(
      new CopyObjectCommand({
        Bucket: "copy-src",
        Key: "with-meta-copy.txt",
        CopySource: "copy-src/with-meta.txt",
      }),
    );

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: "copy-src", Key: "with-meta-copy.txt" }),
    );
    expect(head.Metadata?.author).toBe("test-user");
    expect(head.Metadata?.version).toBe("1");
  });

  it("returns InvalidArgument error for malformed copy source (no slash)", async () => {
    await expect(
      s3.send(
        new CopyObjectCommand({
          Bucket: "copy-dst",
          Key: "bad-copy.txt",
          CopySource: "no-slash-here",
        }),
      ),
    ).rejects.toThrow();
  });

  it("returns error when source object does not exist", async () => {
    await expect(
      s3.send(
        new CopyObjectCommand({
          Bucket: "copy-dst",
          Key: "nonexistent-copy.txt",
          CopySource: "copy-src/does-not-exist.txt",
        }),
      ),
    ).rejects.toThrow();
  });
});
