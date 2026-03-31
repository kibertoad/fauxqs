import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Error Differentiation", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "error-diff-bucket" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("error XML contains 16-char uppercase alphanumeric RequestId", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/no-such-bucket-rid/key`,
    );
    const xml = await res.text();
    const match = xml.match(/<RequestId>([^<]+)<\/RequestId>/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/^[A-Z0-9]{16}$/);
  });

  it("GetObject returns NoSuchBucket for non-existent bucket", async () => {
    try {
      await s3.send(new GetObjectCommand({ Bucket: "no-such-bucket-xyz", Key: "key" }));
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("NoSuchBucket");
    }
  });

  it("GetObject returns NoSuchKey for non-existent key in existing bucket", async () => {
    try {
      await s3.send(new GetObjectCommand({ Bucket: "error-diff-bucket", Key: "no-such-key" }));
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("NoSuchKey");
    }
  });

  it("HeadObject returns 404 for non-existent key", async () => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: "error-diff-bucket", Key: "missing-key" }));
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.$metadata?.httpStatusCode).toBe(404);
    }
  });

  it("HeadObject returns 404 for non-existent bucket", async () => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: "no-such-bucket-head", Key: "key" }));
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.$metadata?.httpStatusCode).toBe(404);
    }
  });

  it("DeleteObject returns NoSuchBucket for non-existent bucket", async () => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: "no-such-bucket-del", Key: "key" }));
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("NoSuchBucket");
    }
  });
});
