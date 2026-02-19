import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { createLocalhostHandler } from "../../src/localhost.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Virtual-hosted-style (createLocalhostHandler)", () => {
  let server: FauxqsServer;
  let s3: S3Client;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = new S3Client({
      endpoint: `http://s3.localhost:${server.port}`,
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      requestHandler: createLocalhostHandler(),
    });
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("creates a bucket", async () => {
    const result = await s3.send(new CreateBucketCommand({ Bucket: "vhost-handler-bucket" }));
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  it("head bucket succeeds", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-handler-head" }));
    const result = await s3.send(new HeadBucketCommand({ Bucket: "vhost-handler-head" }));
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  it("puts and gets an object", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-handler-objects" }));
    await s3.send(new PutObjectCommand({
      Bucket: "vhost-handler-objects",
      Key: "hello.txt",
      Body: "world",
      ContentType: "text/plain",
    }));

    const result = await s3.send(new GetObjectCommand({
      Bucket: "vhost-handler-objects",
      Key: "hello.txt",
    }));

    expect(await result.Body?.transformToString()).toBe("world");
    expect(result.ContentType).toBe("text/plain");
  });

  it("head object returns metadata", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-handler-headobj" }));
    await s3.send(new PutObjectCommand({
      Bucket: "vhost-handler-headobj",
      Key: "meta.txt",
      Body: "data",
    }));

    const result = await s3.send(new HeadObjectCommand({
      Bucket: "vhost-handler-headobj",
      Key: "meta.txt",
    }));

    expect(result.$metadata.httpStatusCode).toBe(200);
    expect(result.ContentLength).toBe(4);
  });

  it("deletes an object", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-handler-delete" }));
    await s3.send(new PutObjectCommand({
      Bucket: "vhost-handler-delete",
      Key: "gone.txt",
      Body: "bye",
    }));

    const result = await s3.send(new DeleteObjectCommand({
      Bucket: "vhost-handler-delete",
      Key: "gone.txt",
    }));
    expect(result.$metadata.httpStatusCode).toBe(204);

    await expect(
      s3.send(new GetObjectCommand({ Bucket: "vhost-handler-delete", Key: "gone.txt" })),
    ).rejects.toThrow();
  });

  it("supports keys with slashes", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "vhost-handler-slashes" }));
    await s3.send(new PutObjectCommand({
      Bucket: "vhost-handler-slashes",
      Key: "path/to/file.txt",
      Body: "nested",
    }));

    const result = await s3.send(new GetObjectCommand({
      Bucket: "vhost-handler-slashes",
      Key: "path/to/file.txt",
    }));
    expect(await result.Body?.transformToString()).toBe("nested");
  });
});
