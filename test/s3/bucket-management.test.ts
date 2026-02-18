import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Bucket Management", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("creates a bucket", async () => {
    const result = await s3.send(
      new CreateBucketCommand({ Bucket: "test-bucket" }),
    );
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  it("create bucket is idempotent", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "idempotent-bucket" }));
    const result = await s3.send(
      new CreateBucketCommand({ Bucket: "idempotent-bucket" }),
    );
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  it("head bucket succeeds for existing bucket", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "head-bucket" }));
    const result = await s3.send(
      new HeadBucketCommand({ Bucket: "head-bucket" }),
    );
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  it("head bucket returns 404 for missing bucket", async () => {
    await expect(
      s3.send(new HeadBucketCommand({ Bucket: "nonexistent-bucket" })),
    ).rejects.toThrow();
  });
});
