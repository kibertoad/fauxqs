import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 List and Bulk Delete", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "list-bucket" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("lists objects in a bucket", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "list-bucket",
        Key: "file1.txt",
        Body: "content1",
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: "list-bucket",
        Key: "file2.txt",
        Body: "content2",
      }),
    );

    const result = await s3.send(
      new ListObjectsCommand({ Bucket: "list-bucket" }),
    );
    const keys = (result.Contents ?? []).map((c) => c.Key);
    expect(keys).toContain("file1.txt");
    expect(keys).toContain("file2.txt");
  });

  it("bulk deletes objects", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: "list-bucket",
        Key: "del1.txt",
        Body: "a",
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: "list-bucket",
        Key: "del2.txt",
        Body: "b",
      }),
    );

    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: "list-bucket",
        Delete: {
          Objects: [{ Key: "del1.txt" }, { Key: "del2.txt" }],
        },
      }),
    );

    const deletedKeys = (result.Deleted ?? []).map((d) => d.Key);
    expect(deletedKeys).toContain("del1.txt");
    expect(deletedKeys).toContain("del2.txt");

    // Verify they're actually gone
    await expect(
      s3.send(
        new GetObjectCommand({ Bucket: "list-bucket", Key: "del1.txt" }),
      ),
    ).rejects.toThrow();
  });
});
