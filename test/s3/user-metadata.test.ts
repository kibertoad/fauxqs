import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 User Metadata (x-amz-meta-*)", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "meta-bucket" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("stores and returns user metadata on PutObject/GetObject", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "meta-bucket",
        Key: "with-meta.txt",
        Body: "hello",
        Metadata: { author: "alice", version: "42" },
      }),
    );

    const result = await s3.send(
      new GetObjectCommand({ Bucket: "meta-bucket", Key: "with-meta.txt" }),
    );
    expect(result.Metadata).toBeDefined();
    expect(result.Metadata!.author).toBe("alice");
    expect(result.Metadata!.version).toBe("42");
  });

  it("returns user metadata on HeadObject", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "meta-bucket",
        Key: "head-meta.txt",
        Body: "test",
        Metadata: { "content-hash": "abc123" },
      }),
    );

    const result = await s3.send(
      new HeadObjectCommand({ Bucket: "meta-bucket", Key: "head-meta.txt" }),
    );
    expect(result.Metadata).toBeDefined();
    expect(result.Metadata!["content-hash"]).toBe("abc123");
  });

  it("fully replaces metadata on re-PutObject (old keys are removed)", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "meta-bucket",
        Key: "replace-meta.txt",
        Body: "v1",
        Metadata: { color: "red", size: "large" },
      }),
    );

    // Overwrite with completely different metadata keys
    await s3.send(
      new PutObjectCommand({
        Bucket: "meta-bucket",
        Key: "replace-meta.txt",
        Body: "v2",
        Metadata: { shape: "circle" },
      }),
    );

    const result = await s3.send(
      new GetObjectCommand({ Bucket: "meta-bucket", Key: "replace-meta.txt" }),
    );
    expect(result.Metadata).toBeDefined();
    expect(result.Metadata!.shape).toBe("circle");
    // Old keys should be gone
    expect(result.Metadata!.color).toBeUndefined();
    expect(result.Metadata!.size).toBeUndefined();
  });

  it("overwrites metadata values on re-PutObject", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "meta-bucket",
        Key: "overwrite.txt",
        Body: "v1",
        Metadata: { version: "1" },
      }),
    );

    await s3.send(
      new PutObjectCommand({
        Bucket: "meta-bucket",
        Key: "overwrite.txt",
        Body: "v2",
        Metadata: { version: "2", author: "bob" },
      }),
    );

    const result = await s3.send(
      new GetObjectCommand({ Bucket: "meta-bucket", Key: "overwrite.txt" }),
    );
    expect(result.Metadata!.version).toBe("2");
    expect(result.Metadata!.author).toBe("bob");
  });
});
