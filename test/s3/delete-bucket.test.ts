import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 DeleteBucket", () => {
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

  it("deletes an empty bucket", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "delete-me-bucket" }));

    // Verify bucket exists
    await s3.send(new HeadBucketCommand({ Bucket: "delete-me-bucket" }));

    // Delete it
    await s3.send(new DeleteBucketCommand({ Bucket: "delete-me-bucket" }));

    // Bucket should no longer exist
    await expect(
      s3.send(new HeadBucketCommand({ Bucket: "delete-me-bucket" })),
    ).rejects.toThrow();
  });

  it("rejects deleting a non-empty bucket", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "non-empty-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "non-empty-bucket",
        Key: "file.txt",
        Body: "content",
      }),
    );

    await expect(
      s3.send(new DeleteBucketCommand({ Bucket: "non-empty-bucket" })),
    ).rejects.toThrow();
  });

  it("rejects deleting a non-existent bucket", async () => {
    await expect(
      s3.send(new DeleteBucketCommand({ Bucket: "no-such-bucket" })),
    ).rejects.toThrow();
  });
});

describe("S3 DeleteObject bucket check", () => {
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

  it("returns error when deleting object from non-existent bucket", async () => {
    await expect(
      s3.send(
        new DeleteObjectCommand({
          Bucket: "nonexistent-bucket-for-delete",
          Key: "some-key",
        }),
      ),
    ).rejects.toThrow();
  });

  it("silently succeeds for non-existent key in existing bucket", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "existing-bucket-del" }));

    // AWS returns 204 for deleting non-existent key in existing bucket
    const result = await s3.send(
      new DeleteObjectCommand({
        Bucket: "existing-bucket-del",
        Key: "no-such-key",
      }),
    );
    expect(result.$metadata.httpStatusCode).toBe(204);
  });
});
