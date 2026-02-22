import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Bucket Name Validation", () => {
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

  it("accepts valid bucket names", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "my-valid-bucket" }));
    await s3.send(new CreateBucketCommand({ Bucket: "bucket123" }));
    await s3.send(new CreateBucketCommand({ Bucket: "my.bucket.name" }));
    await s3.send(new CreateBucketCommand({ Bucket: "abc" }));
  });

  it("rejects names shorter than 3 characters", async () => {
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: "ab" })),
    ).rejects.toThrow();
  });

  it("rejects names longer than 63 characters", async () => {
    const longName = "a".repeat(64);
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: longName })),
    ).rejects.toThrow();
  });

  it("rejects names with uppercase letters", async () => {
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: "MyBucket" })),
    ).rejects.toThrow();
  });

  it("rejects names with special characters", async () => {
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: "my_bucket" })),
    ).rejects.toThrow();
  });

  it("rejects names that look like IP addresses", async () => {
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: "192.168.1.1" })),
    ).rejects.toThrow();
  });

  it("rejects names with consecutive periods", async () => {
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: "my..bucket" })),
    ).rejects.toThrow();
  });

  it("rejects names with period-hyphen adjacency", async () => {
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: "my.-bucket" })),
    ).rejects.toThrow();
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: "my-.bucket" })),
    ).rejects.toThrow();
  });

  it("rejects names starting with hyphen", async () => {
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: "-mybucket" })),
    ).rejects.toThrow();
  });

  it("rejects names ending with hyphen", async () => {
    await expect(
      s3.send(new CreateBucketCommand({ Bucket: "mybucket-" })),
    ).rejects.toThrow();
  });
});
