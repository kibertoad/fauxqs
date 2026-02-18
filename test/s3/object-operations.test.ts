import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Object Operations", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "obj-bucket" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("puts and gets a string body", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "obj-bucket",
        Key: "hello.txt",
        Body: "Hello, world!",
      }),
    );

    const result = await s3.send(
      new GetObjectCommand({ Bucket: "obj-bucket", Key: "hello.txt" }),
    );
    const body = await result.Body!.transformToString();
    expect(body).toBe("Hello, world!");
  });

  it("puts and gets a buffer body", async () => {
    const data = Buffer.from("binary data here");
    await s3.send(
      new PutObjectCommand({
        Bucket: "obj-bucket",
        Key: "data.bin",
        Body: data,
      }),
    );

    const result = await s3.send(
      new GetObjectCommand({ Bucket: "obj-bucket", Key: "data.bin" }),
    );
    const body = await result.Body!.transformToByteArray();
    expect(Buffer.from(body)).toEqual(data);
  });

  it("returns ETag on put", async () => {
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: "obj-bucket",
        Key: "etag-test.txt",
        Body: "test",
      }),
    );
    expect(result.ETag).toBeDefined();
  });

  it("throws NoSuchKey for missing object", async () => {
    await expect(
      s3.send(
        new GetObjectCommand({ Bucket: "obj-bucket", Key: "nonexistent.txt" }),
      ),
    ).rejects.toThrow();
  });

  it("delete object silently succeeds for missing key", async () => {
    const result = await s3.send(
      new DeleteObjectCommand({
        Bucket: "obj-bucket",
        Key: "does-not-exist.txt",
      }),
    );
    expect(result.$metadata.httpStatusCode).toBe(204);
  });

  it("head object succeeds for existing object", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "obj-bucket",
        Key: "head-test.txt",
        Body: "test data",
      }),
    );

    const result = await s3.send(
      new HeadObjectCommand({ Bucket: "obj-bucket", Key: "head-test.txt" }),
    );
    expect(result.$metadata.httpStatusCode).toBe(200);
    expect(result.ContentLength).toBe(9);
  });

  it("head object throws for missing object", async () => {
    await expect(
      s3.send(
        new HeadObjectCommand({
          Bucket: "obj-bucket",
          Key: "missing-head.txt",
        }),
      ),
    ).rejects.toThrow();
  });

  it("supports keys with slashes", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "obj-bucket",
        Key: "path/to/nested/file.txt",
        Body: "nested content",
      }),
    );

    const result = await s3.send(
      new GetObjectCommand({
        Bucket: "obj-bucket",
        Key: "path/to/nested/file.txt",
      }),
    );
    const body = await result.Body!.transformToString();
    expect(body).toBe("nested content");
  });
});
