import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Presigned URLs", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "presigned-bucket" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("presigned GET returns object body", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "presigned-bucket",
        Key: "get-test.txt",
        Body: "presigned content",
      }),
    );

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: "presigned-bucket", Key: "get-test.txt" }),
      { expiresIn: 900 },
    );

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("presigned content");
  });

  it("presigned PUT uploads object", async () => {
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: "presigned-bucket", Key: "put-test.txt" }),
      { expiresIn: 900 },
    );

    const res = await fetch(url, { method: "PUT", body: "uploaded via presigned" });
    expect(res.status).toBe(200);

    const get = await s3.send(
      new GetObjectCommand({ Bucket: "presigned-bucket", Key: "put-test.txt" }),
    );
    expect(await get.Body!.transformToString()).toBe("uploaded via presigned");
  });

  it("presigned PUT preserves Content-Type", async () => {
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: "presigned-bucket",
        Key: "typed.json",
        ContentType: "application/json",
      }),
      { expiresIn: 900 },
    );

    await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: '{"ok":true}',
    });

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: "presigned-bucket", Key: "typed.json" }),
    );
    expect(head.ContentType).toBe("application/json");
  });

  it("presigned HEAD returns status and headers", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "presigned-bucket",
        Key: "head-test.txt",
        Body: "head me",
      }),
    );

    const url = await getSignedUrl(
      s3,
      new HeadObjectCommand({ Bucket: "presigned-bucket", Key: "head-test.txt" }),
      { expiresIn: 900 },
    );

    const res = await fetch(url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("7");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("presigned DELETE removes object", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "presigned-bucket",
        Key: "delete-me.txt",
        Body: "bye",
      }),
    );

    const url = await getSignedUrl(
      s3,
      new DeleteObjectCommand({ Bucket: "presigned-bucket", Key: "delete-me.txt" }),
      { expiresIn: 900 },
    );

    const res = await fetch(url, { method: "DELETE" });
    expect(res.status).toBe(204);

    await expect(
      s3.send(new GetObjectCommand({ Bucket: "presigned-bucket", Key: "delete-me.txt" })),
    ).rejects.toThrow();
  });

  it("presigned GET for missing key returns 404", async () => {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: "presigned-bucket", Key: "nonexistent.txt" }),
      { expiresIn: 900 },
    );

    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it("presigned GET works with nested keys (slashes)", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "presigned-bucket",
        Key: "a/b/c/nested.txt",
        Body: "deep",
      }),
    );

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: "presigned-bucket", Key: "a/b/c/nested.txt" }),
      { expiresIn: 900 },
    );

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("deep");
  });
});
