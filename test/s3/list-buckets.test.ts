import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 ListBuckets", () => {
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

  it("returns empty list when no buckets exist", async () => {
    const result = await s3.send(new ListBucketsCommand({}));
    expect(result.Buckets).toEqual([]);
    expect(result.Owner).toBeDefined();
    expect(result.Owner!.ID).toBe("000000000000");
    expect(result.Owner!.DisplayName).toBe("local");
  });

  it("returns created buckets", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "list-bucket-a" }));
    await s3.send(new CreateBucketCommand({ Bucket: "list-bucket-b" }));

    const result = await s3.send(new ListBucketsCommand({}));
    const names = result.Buckets!.map((b) => b.Name);
    expect(names).toContain("list-bucket-a");
    expect(names).toContain("list-bucket-b");
  });

  it("includes CreationDate for each bucket", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "list-bucket-dated" }));

    const result = await s3.send(new ListBucketsCommand({}));
    const bucket = result.Buckets!.find((b) => b.Name === "list-bucket-dated");
    expect(bucket).toBeDefined();
    expect(bucket!.CreationDate).toBeInstanceOf(Date);
  });

  it("reflects deleted buckets", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "list-bucket-temp" }));

    let result = await s3.send(new ListBucketsCommand({}));
    let names = result.Buckets!.map((b) => b.Name);
    expect(names).toContain("list-bucket-temp");

    await s3.send(new DeleteBucketCommand({ Bucket: "list-bucket-temp" }));

    result = await s3.send(new ListBucketsCommand({}));
    names = result.Buckets!.map((b) => b.Name);
    expect(names).not.toContain("list-bucket-temp");
  });

  it("returns buckets in alphabetical order", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "list-bucket-z" }));
    await s3.send(new CreateBucketCommand({ Bucket: "list-bucket-a2" }));
    await s3.send(new CreateBucketCommand({ Bucket: "list-bucket-m" }));

    const result = await s3.send(new ListBucketsCommand({}));
    const names = result.Buckets!.map((b) => b.Name);

    // Filter to only our test buckets to avoid interference
    const testNames = names.filter((n) => n!.startsWith("list-bucket-"));
    const sorted = [...testNames].sort();
    expect(testNames).toEqual(sorted);
  });
});
