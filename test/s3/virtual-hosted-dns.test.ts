import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { interceptLocalhostDns } from "../../src/localhost.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Virtual-hosted-style (interceptLocalhostDns)", () => {
  let server: FauxqsServer;
  let s3: S3Client;
  let restoreDns: () => void;

  beforeAll(async () => {
    restoreDns = interceptLocalhostDns();
    server = await startFauxqsTestServer();
    s3 = new S3Client({
      endpoint: `http://s3.localhost:${server.port}`,
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      // no forcePathStyle, no custom requestHandler
    });
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
    restoreDns();
  });

  it("creates a bucket", async () => {
    const result = await s3.send(new CreateBucketCommand({ Bucket: "vhost-dns-bucket" }));
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  it("head bucket succeeds", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-dns-head" }));
    const result = await s3.send(new HeadBucketCommand({ Bucket: "vhost-dns-head" }));
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  it("puts and gets an object", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-dns-objects" }));
    await s3.send(new PutObjectCommand({
      Bucket: "vhost-dns-objects",
      Key: "hello.txt",
      Body: "world",
      ContentType: "text/plain",
    }));

    const result = await s3.send(new GetObjectCommand({
      Bucket: "vhost-dns-objects",
      Key: "hello.txt",
    }));

    expect(await result.Body?.transformToString()).toBe("world");
    expect(result.ContentType).toBe("text/plain");
  });

  it("head object returns metadata", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-dns-headobj" }));
    await s3.send(new PutObjectCommand({
      Bucket: "vhost-dns-headobj",
      Key: "meta.txt",
      Body: "data",
    }));

    const result = await s3.send(new HeadObjectCommand({
      Bucket: "vhost-dns-headobj",
      Key: "meta.txt",
    }));

    expect(result.$metadata.httpStatusCode).toBe(200);
    expect(result.ContentLength).toBe(4);
  });

  it("deletes an object", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-dns-delete" }));
    await s3.send(new PutObjectCommand({
      Bucket: "vhost-dns-delete",
      Key: "gone.txt",
      Body: "bye",
    }));

    const result = await s3.send(new DeleteObjectCommand({
      Bucket: "vhost-dns-delete",
      Key: "gone.txt",
    }));
    expect(result.$metadata.httpStatusCode).toBe(204);

    await expect(
      s3.send(new GetObjectCommand({ Bucket: "vhost-dns-delete", Key: "gone.txt" })),
    ).rejects.toThrow();
  });

  it("supports keys with slashes", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-dns-slashes" }));
    await s3.send(new PutObjectCommand({
      Bucket: "vhost-dns-slashes",
      Key: "path/to/file.txt",
      Body: "nested",
    }));

    const result = await s3.send(new GetObjectCommand({
      Bucket: "vhost-dns-slashes",
      Key: "path/to/file.txt",
    }));
    expect(await result.Body?.transformToString()).toBe("nested");
  });

  it("custom hostname suffix works", async () => {
    // Verify the configurable hostname parameter
    const restore2 = interceptLocalhostDns("custom.test");
    restore2(); // just verify it doesn't throw
  });
});
