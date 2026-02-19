import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  ListObjectsCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 ListObjects V1 and V2", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "list-v2-bucket" }));

    // Create objects with various key prefixes
    const keys = [
      "docs/readme.md",
      "docs/guide.md",
      "docs/api/v1.md",
      "docs/api/v2.md",
      "images/logo.png",
      "images/banner.png",
      "index.html",
    ];

    for (const key of keys) {
      await s3.send(
        new PutObjectCommand({
          Bucket: "list-v2-bucket",
          Key: key,
          Body: `content-${key}`,
        }),
      );
    }
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  describe("ListObjectsV2", () => {
    it("lists all objects", async () => {
      const result = await s3.send(
        new ListObjectsV2Command({ Bucket: "list-v2-bucket" }),
      );
      expect(result.KeyCount).toBe(7);
      expect(result.Contents).toHaveLength(7);
      expect(result.IsTruncated).toBe(false);
    });

    it("filters by prefix", async () => {
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: "list-v2-bucket",
          Prefix: "docs/",
        }),
      );
      expect(result.Contents).toHaveLength(4);
      const keys = result.Contents!.map((c) => c.Key);
      expect(keys).toContain("docs/readme.md");
      expect(keys).toContain("docs/guide.md");
      expect(keys).toContain("docs/api/v1.md");
      expect(keys).toContain("docs/api/v2.md");
    });

    it("supports delimiter for virtual directories", async () => {
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: "list-v2-bucket",
          Delimiter: "/",
        }),
      );
      // Only top-level objects returned
      expect(result.Contents).toHaveLength(1);
      expect(result.Contents![0].Key).toBe("index.html");
      // Common prefixes for directories
      expect(result.CommonPrefixes).toHaveLength(2);
      const prefixes = result.CommonPrefixes!.map((p) => p.Prefix);
      expect(prefixes).toContain("docs/");
      expect(prefixes).toContain("images/");
    });

    it("supports prefix + delimiter combination", async () => {
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: "list-v2-bucket",
          Prefix: "docs/",
          Delimiter: "/",
        }),
      );
      // Direct children of docs/
      expect(result.Contents).toHaveLength(2);
      const keys = result.Contents!.map((c) => c.Key);
      expect(keys).toContain("docs/readme.md");
      expect(keys).toContain("docs/guide.md");
      // Subdirectory
      expect(result.CommonPrefixes).toHaveLength(1);
      expect(result.CommonPrefixes![0].Prefix).toBe("docs/api/");
    });

    it("respects MaxKeys", async () => {
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: "list-v2-bucket",
          MaxKeys: 3,
        }),
      );
      expect(result.Contents).toHaveLength(3);
      expect(result.IsTruncated).toBe(true);
      expect(result.NextContinuationToken).toBeDefined();
    });

    it("supports pagination with ContinuationToken", async () => {
      const page1 = await s3.send(
        new ListObjectsV2Command({
          Bucket: "list-v2-bucket",
          MaxKeys: 3,
        }),
      );
      expect(page1.IsTruncated).toBe(true);

      const page2 = await s3.send(
        new ListObjectsV2Command({
          Bucket: "list-v2-bucket",
          MaxKeys: 3,
          ContinuationToken: page1.NextContinuationToken,
        }),
      );
      expect(page2.Contents!.length).toBeGreaterThan(0);

      // Ensure no overlap between pages
      const keys1 = page1.Contents!.map((c) => c.Key);
      const keys2 = page2.Contents!.map((c) => c.Key);
      for (const key of keys2) {
        expect(keys1).not.toContain(key);
      }
    });

    it("supports StartAfter", async () => {
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: "list-v2-bucket",
          StartAfter: "docs/readme.md",
        }),
      );
      const keys = result.Contents!.map((c) => c.Key);
      expect(keys).not.toContain("docs/readme.md");
      expect(keys).not.toContain("docs/guide.md");
      expect(keys).not.toContain("docs/api/v1.md");
      expect(keys).not.toContain("docs/api/v2.md");
    });

    it("returns KeyCount in V2 response", async () => {
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: "list-v2-bucket",
          Prefix: "images/",
        }),
      );
      expect(result.KeyCount).toBe(2);
    });
  });

  describe("ListObjectsV1", () => {
    it("lists all objects (V1)", async () => {
      const result = await s3.send(
        new ListObjectsCommand({ Bucket: "list-v2-bucket" }),
      );
      expect(result.Contents).toHaveLength(7);
      expect(result.IsTruncated).toBe(false);
    });

    it("filters by prefix (V1)", async () => {
      const result = await s3.send(
        new ListObjectsCommand({
          Bucket: "list-v2-bucket",
          Prefix: "images/",
        }),
      );
      expect(result.Contents).toHaveLength(2);
      const keys = result.Contents!.map((c) => c.Key);
      expect(keys).toContain("images/logo.png");
      expect(keys).toContain("images/banner.png");
    });

    it("supports delimiter (V1)", async () => {
      const result = await s3.send(
        new ListObjectsCommand({
          Bucket: "list-v2-bucket",
          Delimiter: "/",
        }),
      );
      expect(result.Contents).toHaveLength(1);
      expect(result.CommonPrefixes).toHaveLength(2);
    });

    it("respects MaxKeys (V1)", async () => {
      const result = await s3.send(
        new ListObjectsCommand({
          Bucket: "list-v2-bucket",
          MaxKeys: 2,
        }),
      );
      expect(result.Contents).toHaveLength(2);
      expect(result.IsTruncated).toBe(true);
    });
  });
});
