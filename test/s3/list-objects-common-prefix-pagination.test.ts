import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 ListObjects pagination with CommonPrefixes", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "prefix-pag-bucket" }));

    // Create objects only under directory prefixes, no top-level files
    for (const key of ["aaa/1.txt", "bbb/2.txt", "ccc/3.txt", "ddd/4.txt"]) {
      await s3.send(
        new PutObjectCommand({
          Bucket: "prefix-pag-bucket",
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

  describe("V1", () => {
    it("paginates when all entries on a truncated page are common prefixes", async () => {
      const page1 = await s3.send(
        new ListObjectsCommand({
          Bucket: "prefix-pag-bucket",
          Delimiter: "/",
          MaxKeys: 2,
        }),
      );

      expect(page1.IsTruncated).toBe(true);
      expect(page1.CommonPrefixes).toHaveLength(2);
      expect(page1.Contents ?? []).toHaveLength(0);
      // NextMarker must be set even when there are no object keys
      expect(page1.NextMarker).toBeDefined();
      expect(page1.NextMarker!.length).toBeGreaterThan(0);

      const page2 = await s3.send(
        new ListObjectsCommand({
          Bucket: "prefix-pag-bucket",
          Delimiter: "/",
          MaxKeys: 2,
          Marker: page1.NextMarker,
        }),
      );

      // Page 2 should contain the remaining prefixes
      expect(page2.CommonPrefixes!.length).toBeGreaterThan(0);
      // No overlap between pages
      const page1Prefixes = page1.CommonPrefixes!.map((p) => p.Prefix);
      const page2Prefixes = page2.CommonPrefixes!.map((p) => p.Prefix);
      for (const p of page2Prefixes) {
        expect(page1Prefixes).not.toContain(p);
      }
    });
  });

  describe("V2", () => {
    it("paginates when all entries on a truncated page are common prefixes", async () => {
      const page1 = await s3.send(
        new ListObjectsV2Command({
          Bucket: "prefix-pag-bucket",
          Delimiter: "/",
          MaxKeys: 2,
        }),
      );

      expect(page1.IsTruncated).toBe(true);
      expect(page1.CommonPrefixes).toHaveLength(2);
      expect(page1.Contents ?? []).toHaveLength(0);
      // NextContinuationToken must be set even when there are no object keys
      expect(page1.NextContinuationToken).toBeDefined();

      const page2 = await s3.send(
        new ListObjectsV2Command({
          Bucket: "prefix-pag-bucket",
          Delimiter: "/",
          MaxKeys: 2,
          ContinuationToken: page1.NextContinuationToken,
        }),
      );

      expect(page2.CommonPrefixes!.length).toBeGreaterThan(0);
      const page1Prefixes = page1.CommonPrefixes!.map((p) => p.Prefix);
      const page2Prefixes = page2.CommonPrefixes!.map((p) => p.Prefix);
      for (const p of page2Prefixes) {
        expect(page1Prefixes).not.toContain(p);
      }
    });
  });
});
