import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Multipart Upload", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "multipart-bucket" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  describe("CreateMultipartUpload", () => {
    it("initiates a multipart upload and returns UploadId", async () => {
      const result = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "test-multipart.txt",
        }),
      );

      expect(result.UploadId).toBeDefined();
      expect(result.UploadId!.length).toBeGreaterThan(0);
      expect(result.Bucket).toBe("multipart-bucket");
      expect(result.Key).toBe("test-multipart.txt");

      // Clean up
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "test-multipart.txt",
          UploadId: result.UploadId,
        }),
      );
    });

    it("rejects upload to non-existent bucket", async () => {
      await expect(
        s3.send(
          new CreateMultipartUploadCommand({
            Bucket: "no-such-bucket-multipart",
            Key: "file.txt",
          }),
        ),
      ).rejects.toThrow();
    });

    it("returns unique UploadId for each initiation", async () => {
      const result1 = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "same-key.txt",
        }),
      );
      const result2 = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "same-key.txt",
        }),
      );

      expect(result1.UploadId).not.toBe(result2.UploadId);

      // Clean up
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "same-key.txt",
          UploadId: result1.UploadId,
        }),
      );
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "same-key.txt",
          UploadId: result2.UploadId,
        }),
      );
    });
  });

  describe("UploadPart", () => {
    it("uploads a part and returns an ETag", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "upload-part-test.txt",
        }),
      );

      const result = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "upload-part-test.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "part-1-data",
        }),
      );

      expect(result.ETag).toBeDefined();
      expect(result.ETag!.length).toBeGreaterThan(0);

      // Clean up
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "upload-part-test.txt",
          UploadId: init.UploadId,
        }),
      );
    });

    it("rejects upload for invalid UploadId", async () => {
      await expect(
        s3.send(
          new UploadPartCommand({
            Bucket: "multipart-bucket",
            Key: "any-key.txt",
            UploadId: "invalid-upload-id",
            PartNumber: 1,
            Body: "data",
          }),
        ),
      ).rejects.toThrow();
    });

    it("allows overwriting a part with the same number", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "overwrite-part.txt",
        }),
      );

      const result1 = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "overwrite-part.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "original-data",
        }),
      );

      const result2 = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "overwrite-part.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "overwritten-data",
        }),
      );

      // ETags should differ because content differs
      expect(result1.ETag).not.toBe(result2.ETag);

      // Complete with the overwritten part and verify content
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "overwrite-part.txt",
          UploadId: init.UploadId,
          MultipartUpload: {
            Parts: [{ PartNumber: 1, ETag: result2.ETag }],
          },
        }),
      );

      const obj = await s3.send(
        new GetObjectCommand({
          Bucket: "multipart-bucket",
          Key: "overwrite-part.txt",
        }),
      );
      const body = await obj.Body!.transformToString();
      expect(body).toBe("overwritten-data");
    });
  });

  describe("CompleteMultipartUpload", () => {
    it("assembles parts into a complete object", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "assembled.txt",
        }),
      );

      // Non-last parts must be >= 5 MiB (AWS requirement)
      const fiveMiB = Buffer.alloc(5 * 1024 * 1024, "a");
      const part1 = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "assembled.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: fiveMiB,
        }),
      );

      const part2 = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "assembled.txt",
          UploadId: init.UploadId,
          PartNumber: 2,
          Body: "World!",
        }),
      );

      const complete = await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "assembled.txt",
          UploadId: init.UploadId,
          MultipartUpload: {
            Parts: [
              { PartNumber: 1, ETag: part1.ETag },
              { PartNumber: 2, ETag: part2.ETag },
            ],
          },
        }),
      );

      expect(complete.Bucket).toBe("multipart-bucket");
      expect(complete.Key).toBe("assembled.txt");
      expect(complete.ETag).toBeDefined();
      // Multipart ETag contains a dash followed by the part count
      expect(complete.ETag).toMatch(/-2"/);

      // Verify the assembled object
      const obj = await s3.send(
        new GetObjectCommand({
          Bucket: "multipart-bucket",
          Key: "assembled.txt",
        }),
      );
      const body = await obj.Body!.transformToByteArray();
      expect(body.length).toBe(fiveMiB.length + 6); // "World!" is 6 bytes
    });

    it("returns correct content length for assembled object", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "length-check.bin",
        }),
      );

      // Non-last parts must be >= 5 MiB
      const data1 = Buffer.alloc(5 * 1024 * 1024, "a");
      const data2 = Buffer.alloc(2048, "b");

      const part1 = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "length-check.bin",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: data1,
        }),
      );

      const part2 = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "length-check.bin",
          UploadId: init.UploadId,
          PartNumber: 2,
          Body: data2,
        }),
      );

      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "length-check.bin",
          UploadId: init.UploadId,
          MultipartUpload: {
            Parts: [
              { PartNumber: 1, ETag: part1.ETag },
              { PartNumber: 2, ETag: part2.ETag },
            ],
          },
        }),
      );

      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: "multipart-bucket",
          Key: "length-check.bin",
        }),
      );
      expect(head.ContentLength).toBe(5 * 1024 * 1024 + 2048);
    });

    it("rejects completion with invalid UploadId", async () => {
      await expect(
        s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: "multipart-bucket",
            Key: "any.txt",
            UploadId: "nonexistent-upload",
            MultipartUpload: {
              Parts: [{ PartNumber: 1, ETag: '"abc"' }],
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects completion with missing part", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "missing-part.txt",
        }),
      );

      const part1 = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "missing-part.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "data",
        }),
      );

      await expect(
        s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: "multipart-bucket",
            Key: "missing-part.txt",
            UploadId: init.UploadId,
            MultipartUpload: {
              Parts: [
                { PartNumber: 1, ETag: part1.ETag },
                { PartNumber: 2, ETag: '"nonexistent"' },
              ],
            },
          }),
        ),
      ).rejects.toThrow();

      // Clean up
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "missing-part.txt",
          UploadId: init.UploadId,
        }),
      );
    });

    it("allows completing with a subset of uploaded parts", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "subset-parts.txt",
        }),
      );

      // Non-last parts must be >= 5 MiB
      const fiveMiB = Buffer.alloc(5 * 1024 * 1024, "x");
      const part1 = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "subset-parts.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: fiveMiB,
        }),
      );

      // Upload part 2 but don't include it in completion
      await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "subset-parts.txt",
          UploadId: init.UploadId,
          PartNumber: 2,
          Body: "part-2",
        }),
      );

      const part3 = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "subset-parts.txt",
          UploadId: init.UploadId,
          PartNumber: 3,
          Body: "part-3",
        }),
      );

      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "subset-parts.txt",
          UploadId: init.UploadId,
          MultipartUpload: {
            Parts: [
              { PartNumber: 1, ETag: part1.ETag },
              { PartNumber: 3, ETag: part3.ETag },
            ],
          },
        }),
      );

      const obj = await s3.send(
        new GetObjectCommand({
          Bucket: "multipart-bucket",
          Key: "subset-parts.txt",
        }),
      );
      const body = await obj.Body!.transformToByteArray();
      expect(body.length).toBe(fiveMiB.length + 6); // "part-3" is 6 bytes
    });

    it("makes completed object visible in listings", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "visible-after-complete.txt",
        }),
      );

      const part = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "visible-after-complete.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "content",
        }),
      );

      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "visible-after-complete.txt",
          UploadId: init.UploadId,
          MultipartUpload: {
            Parts: [{ PartNumber: 1, ETag: part.ETag }],
          },
        }),
      );

      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: "multipart-bucket",
          Prefix: "visible-after-complete",
        }),
      );
      expect(list.Contents).toHaveLength(1);
      expect(list.Contents![0].Key).toBe("visible-after-complete.txt");
    });

    it("rejects completing an already-completed upload", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "double-complete.txt",
        }),
      );

      const part = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "double-complete.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "data",
        }),
      );

      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "double-complete.txt",
          UploadId: init.UploadId,
          MultipartUpload: {
            Parts: [{ PartNumber: 1, ETag: part.ETag }],
          },
        }),
      );

      // Second completion should fail — upload no longer exists
      await expect(
        s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: "multipart-bucket",
            Key: "double-complete.txt",
            UploadId: init.UploadId,
            MultipartUpload: {
              Parts: [{ PartNumber: 1, ETag: part.ETag }],
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it("preserves metadata from initiation", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "meta-multipart.txt",
          ContentType: "text/plain",
          Metadata: { author: "test-user", version: "42" },
        }),
      );

      const part = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "meta-multipart.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "metadata test",
        }),
      );

      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "meta-multipart.txt",
          UploadId: init.UploadId,
          MultipartUpload: {
            Parts: [{ PartNumber: 1, ETag: part.ETag }],
          },
        }),
      );

      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: "multipart-bucket",
          Key: "meta-multipart.txt",
        }),
      );
      expect(head.Metadata).toEqual({ author: "test-user", version: "42" });
    });
  });

  describe("In-progress upload isolation", () => {
    it("does not make key visible before completion", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "not-visible-yet.txt",
        }),
      );

      await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "not-visible-yet.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "pending data",
        }),
      );

      // Key should not be retrievable before completion
      await expect(
        s3.send(
          new GetObjectCommand({
            Bucket: "multipart-bucket",
            Key: "not-visible-yet.txt",
          }),
        ),
      ).rejects.toThrow();

      // Key should not appear in listings
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: "multipart-bucket",
          Prefix: "not-visible-yet",
        }),
      );
      expect(list.Contents ?? []).toHaveLength(0);

      // Clean up
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "not-visible-yet.txt",
          UploadId: init.UploadId,
        }),
      );
    });
  });

  describe("AbortMultipartUpload", () => {
    it("aborts an in-progress multipart upload", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "abort-test.txt",
        }),
      );

      await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "abort-test.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "part data",
        }),
      );

      // Abort should succeed
      const result = await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "abort-test.txt",
          UploadId: init.UploadId,
        }),
      );
      expect(result.$metadata.httpStatusCode).toBe(204);

      // Cannot upload more parts to aborted upload
      await expect(
        s3.send(
          new UploadPartCommand({
            Bucket: "multipart-bucket",
            Key: "abort-test.txt",
            UploadId: init.UploadId,
            PartNumber: 2,
            Body: "more data",
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects aborting a non-existent upload", async () => {
      await expect(
        s3.send(
          new AbortMultipartUploadCommand({
            Bucket: "multipart-bucket",
            Key: "any.txt",
            UploadId: "nonexistent-upload-id",
          }),
        ),
      ).rejects.toThrow();
    });

    it("cannot complete an aborted upload", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "abort-then-complete.txt",
        }),
      );

      const part = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "abort-then-complete.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "data",
        }),
      );

      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "abort-then-complete.txt",
          UploadId: init.UploadId,
        }),
      );

      await expect(
        s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: "multipart-bucket",
            Key: "abort-then-complete.txt",
            UploadId: init.UploadId,
            MultipartUpload: {
              Parts: [{ PartNumber: 1, ETag: part.ETag }],
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it("aborted upload does not produce an object", async () => {
      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "no-object-after-abort.txt",
        }),
      );

      await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-bucket",
          Key: "no-object-after-abort.txt",
          UploadId: init.UploadId,
          PartNumber: 1,
          Body: "data",
        }),
      );

      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-bucket",
          Key: "no-object-after-abort.txt",
          UploadId: init.UploadId,
        }),
      );

      await expect(
        s3.send(
          new GetObjectCommand({
            Bucket: "multipart-bucket",
            Key: "no-object-after-abort.txt",
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("DeleteBucket with active multipart uploads", () => {
    it("rejects deleting bucket with in-progress multipart upload", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "multipart-delete-test" }));

      const init = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: "multipart-delete-test",
          Key: "in-progress.txt",
        }),
      );

      await expect(
        s3.send(new DeleteBucketCommand({ Bucket: "multipart-delete-test" })),
      ).rejects.toThrow();

      // Clean up
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: "multipart-delete-test",
          Key: "in-progress.txt",
          UploadId: init.UploadId,
        }),
      );
      await s3.send(new DeleteBucketCommand({ Bucket: "multipart-delete-test" }));
    });
  });
});
