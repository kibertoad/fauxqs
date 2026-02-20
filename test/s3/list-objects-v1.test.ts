import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 ListObjects V1", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "list-v1-bucket" }));

    // Create test objects
    for (const key of ["a.txt", "b.txt", "c.txt", "dir/d.txt", "dir/e.txt", "other/f.txt"]) {
      await s3.send(
        new PutObjectCommand({
          Bucket: "list-v1-bucket",
          Key: key,
          Body: `content of ${key}`,
        }),
      );
    }
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("lists all objects", async () => {
    const result = await s3.send(
      new ListObjectsCommand({ Bucket: "list-v1-bucket" }),
    );

    expect(result.Contents).toHaveLength(6);
    expect(result.IsTruncated).toBe(false);
    expect(result.Name).toBe("list-v1-bucket");
  });

  it("lists objects with prefix", async () => {
    const result = await s3.send(
      new ListObjectsCommand({ Bucket: "list-v1-bucket", Prefix: "dir/" }),
    );

    expect(result.Contents).toHaveLength(2);
    expect(result.Contents![0].Key).toBe("dir/d.txt");
    expect(result.Contents![1].Key).toBe("dir/e.txt");
  });

  it("lists objects with delimiter", async () => {
    const result = await s3.send(
      new ListObjectsCommand({ Bucket: "list-v1-bucket", Delimiter: "/" }),
    );

    // Top-level files only
    expect(result.Contents).toHaveLength(3);
    expect(result.CommonPrefixes).toHaveLength(2);
    expect(result.CommonPrefixes!.map((p) => p.Prefix)).toContain("dir/");
    expect(result.CommonPrefixes!.map((p) => p.Prefix)).toContain("other/");
  });

  it("paginates with Marker", async () => {
    const page1 = await s3.send(
      new ListObjectsCommand({ Bucket: "list-v1-bucket", MaxKeys: 2 }),
    );

    expect(page1.Contents).toHaveLength(2);
    expect(page1.IsTruncated).toBe(true);

    const page2 = await s3.send(
      new ListObjectsCommand({
        Bucket: "list-v1-bucket",
        MaxKeys: 2,
        Marker: page1.Contents![1].Key,
      }),
    );

    expect(page2.Contents).toHaveLength(2);
    // No overlap between pages
    expect(page2.Contents![0].Key).not.toBe(page1.Contents![1].Key);
  });

  it("returns NextMarker when truncated with delimiter", async () => {
    const result = await s3.send(
      new ListObjectsCommand({
        Bucket: "list-v1-bucket",
        MaxKeys: 2,
        Delimiter: "/",
      }),
    );

    expect(result.IsTruncated).toBe(true);
    expect(result.NextMarker).toBeDefined();
  });
});
