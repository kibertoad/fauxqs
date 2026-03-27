import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ChecksumAlgorithm,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqs, type FauxqsServer } from "../../src/app.js";

/**
 * Helper to send a raw RenameObject request (PUT /:bucket/:key?renameObject).
 * Uses fetch because the SDK's RenameObjectCommand requires directory bucket
 * endpoint resolution which doesn't map to our local emulator endpoint.
 */
async function renameObject(
  port: number,
  bucket: string,
  destKey: string,
  sourceKey: string,
  headers?: Record<string, string>,
): Promise<Response> {
  const url = `http://127.0.0.1:${port}/${bucket}/${encodeURIComponent(destKey)}?renameObject`;
  return fetch(url, {
    method: "PUT",
    headers: {
      "x-amz-rename-source": encodeURIComponent(sourceKey),
      ...headers,
    },
  });
}

describe("S3 RenameObject", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
    s3 = createS3Client(server.port);
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  beforeEach(async () => {
    await server.reset();
  });

  describe("basic rename", () => {
    it("renames object preserving body, content-type, metadata, and ETag", async () => {
      server.createBucket("rename-dir", { type: "directory" });
      await s3.send(
        new PutObjectCommand({
          Bucket: "rename-dir",
          Key: "old-key.txt",
          Body: "hello world",
          ContentType: "text/plain",
          Metadata: { foo: "bar" },
        }),
      );

      const headBefore = await s3.send(
        new HeadObjectCommand({ Bucket: "rename-dir", Key: "old-key.txt" }),
      );
      const etagBefore = headBefore.ETag;

      const res = await renameObject(server.port, "rename-dir", "new-key.txt", "old-key.txt");
      expect(res.status).toBe(200);

      // New key should exist with same data
      const getResult = await s3.send(
        new GetObjectCommand({ Bucket: "rename-dir", Key: "new-key.txt" }),
      );
      expect(await getResult.Body!.transformToString()).toBe("hello world");
      expect(getResult.ContentType).toBe("text/plain");
      expect(getResult.ETag).toBe(etagBefore);
      expect(getResult.Metadata).toEqual({ foo: "bar" });

      // Old key should be gone
      await expect(
        s3.send(new GetObjectCommand({ Bucket: "rename-dir", Key: "old-key.txt" })),
      ).rejects.toThrow();
    });

    it("preserves system metadata (content-language, cache-control, etc.)", async () => {
      server.createBucket("rename-sys", { type: "directory" });
      await s3.send(
        new PutObjectCommand({
          Bucket: "rename-sys",
          Key: "src.txt",
          Body: "data",
          ContentLanguage: "en-US",
          CacheControl: "max-age=300",
          ContentDisposition: "attachment",
        }),
      );

      const res = await renameObject(server.port, "rename-sys", "dest.txt", "src.txt");
      expect(res.status).toBe(200);

      const head = await s3.send(
        new HeadObjectCommand({ Bucket: "rename-sys", Key: "dest.txt" }),
      );
      expect(head.ContentLanguage).toBe("en-US");
      expect(head.CacheControl).toBe("max-age=300");
      expect(head.ContentDisposition).toBe("attachment");
    });

    it("preserves checksums", async () => {
      server.createBucket("rename-cksum", { type: "directory" });
      await s3.send(
        new PutObjectCommand({
          Bucket: "rename-cksum",
          Key: "src.bin",
          Body: Buffer.from("checksum-data"),
          ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
        }),
      );

      // Read the checksum before rename
      const headBefore = await s3.send(
        new HeadObjectCommand({
          Bucket: "rename-cksum",
          Key: "src.bin",
          ChecksumMode: "ENABLED",
        }),
      );

      const res = await renameObject(server.port, "rename-cksum", "dest.bin", "src.bin");
      expect(res.status).toBe(200);

      const headAfter = await s3.send(
        new HeadObjectCommand({
          Bucket: "rename-cksum",
          Key: "dest.bin",
          ChecksumMode: "ENABLED",
        }),
      );
      expect(headAfter.ChecksumSHA256).toBe(headBefore.ChecksumSHA256);
    });
  });

  describe("error cases", () => {
    it("returns NoSuchKey when source does not exist", async () => {
      server.createBucket("rename-err", { type: "directory" });
      const res = await renameObject(server.port, "rename-err", "dest.txt", "nonexistent.txt");
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("NoSuchKey");
    });

    it("returns NoSuchBucket when bucket does not exist", async () => {
      const res = await renameObject(server.port, "no-such-bucket-rename", "dest.txt", "src.txt");
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("NoSuchBucket");
    });

    it("rejects general-purpose bucket with InvalidRequest", async () => {
      server.createBucket("rename-gp");
      await s3.send(
        new PutObjectCommand({
          Bucket: "rename-gp",
          Key: "src.txt",
          Body: "data",
        }),
      );

      const res = await renameObject(server.port, "rename-gp", "dest.txt", "src.txt");
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("InvalidRequest");
      expect(body).toContain("directory");
    });

    it("returns error when x-amz-rename-source header is missing", async () => {
      server.createBucket("rename-no-hdr", { type: "directory" });
      const url = `http://127.0.0.1:${server.port}/rename-no-hdr/dest.txt?renameObject`;
      const res = await fetch(url, { method: "PUT" });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("InvalidRequest");
    });

    it("rejects source key ending with /", async () => {
      server.createBucket("rename-slash", { type: "directory" });
      const res = await renameObject(server.port, "rename-slash", "dest.txt", "folder/");
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("InvalidRequest");
    });

    it("rejects destination key ending with /", async () => {
      server.createBucket("rename-slash2", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-slash2", Key: "src.txt", Body: "data" }),
      );
      // Build URL manually since our helper would encode the /
      const url = `http://127.0.0.1:${server.port}/rename-slash2/folder/?renameObject`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { "x-amz-rename-source": "src.txt" },
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("InvalidRequest");
    });
  });

  describe("default no-overwrite behavior", () => {
    it("fails with 412 when destination exists and no conditionals provided", async () => {
      server.createBucket("rename-noov", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-noov", Key: "src.txt", Body: "source" }),
      );
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-noov", Key: "dest.txt", Body: "existing" }),
      );

      const res = await renameObject(server.port, "rename-noov", "dest.txt", "src.txt");
      expect(res.status).toBe(412);
    });

    it("same-key rename fails with 412 (destination = source exists)", async () => {
      server.createBucket("rename-same", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-same", Key: "same.txt", Body: "no change" }),
      );

      const res = await renameObject(server.port, "rename-same", "same.txt", "same.txt");
      expect(res.status).toBe(412);
    });

    it("If-Match allows overwrite when ETag matches", async () => {
      server.createBucket("rename-ifm", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-ifm", Key: "src.txt", Body: "new content" }),
      );
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-ifm", Key: "dest.txt", Body: "old content" }),
      );
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: "rename-ifm", Key: "dest.txt" }),
      );

      const res = await renameObject(server.port, "rename-ifm", "dest.txt", "src.txt", {
        "if-match": head.ETag!,
      });
      expect(res.status).toBe(200);

      const getResult = await s3.send(
        new GetObjectCommand({ Bucket: "rename-ifm", Key: "dest.txt" }),
      );
      expect(await getResult.Body!.transformToString()).toBe("new content");
    });

    it("If-Match fails when ETag does not match", async () => {
      server.createBucket("rename-ifm2", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-ifm2", Key: "src.txt", Body: "data" }),
      );
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-ifm2", Key: "dest.txt", Body: "existing" }),
      );

      const res = await renameObject(server.port, "rename-ifm2", "dest.txt", "src.txt", {
        "if-match": '"wrong-etag"',
      });
      expect(res.status).toBe(412);
    });

    it("If-Match fails when destination does not exist", async () => {
      server.createBucket("rename-ifm3", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-ifm3", Key: "src.txt", Body: "data" }),
      );

      const res = await renameObject(server.port, "rename-ifm3", "no-dest.txt", "src.txt", {
        "if-match": '"some-etag"',
      });
      expect(res.status).toBe(412);
    });
  });

  describe("destination conditionals", () => {
    it("If-None-Match: * prevents overwrite when destination exists", async () => {
      server.createBucket("rename-cond", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-cond", Key: "src.txt", Body: "source" }),
      );
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-cond", Key: "dest.txt", Body: "existing" }),
      );

      const res = await renameObject(server.port, "rename-cond", "dest.txt", "src.txt", {
        "if-none-match": "*",
      });
      expect(res.status).toBe(412);
    });

    it("If-None-Match: * succeeds when destination does not exist", async () => {
      server.createBucket("rename-cond2", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-cond2", Key: "src.txt", Body: "source" }),
      );

      const res = await renameObject(server.port, "rename-cond2", "new-dest.txt", "src.txt", {
        "if-none-match": "*",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("source conditionals", () => {
    it("x-amz-rename-source-if-match succeeds with correct ETag", async () => {
      server.createBucket("rename-src-cond", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-src-cond", Key: "src.txt", Body: "data" }),
      );
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: "rename-src-cond", Key: "src.txt" }),
      );

      const res = await renameObject(server.port, "rename-src-cond", "dest.txt", "src.txt", {
        "x-amz-rename-source-if-match": head.ETag!,
      });
      expect(res.status).toBe(200);
    });

    it("x-amz-rename-source-if-match fails with wrong ETag", async () => {
      server.createBucket("rename-src-cond2", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-src-cond2", Key: "src.txt", Body: "data" }),
      );

      const res = await renameObject(server.port, "rename-src-cond2", "dest.txt", "src.txt", {
        "x-amz-rename-source-if-match": '"wrong-etag"',
      });
      expect(res.status).toBe(412);
    });
  });

  describe("special characters", () => {
    it("handles URL-encoded source keys", async () => {
      server.createBucket("rename-special", { type: "directory" });
      const specialKey = "path/to/file with spaces.txt";
      await s3.send(
        new PutObjectCommand({
          Bucket: "rename-special",
          Key: specialKey,
          Body: "special",
        }),
      );

      const res = await renameObject(
        server.port,
        "rename-special",
        "renamed.txt",
        specialKey,
      );
      expect(res.status).toBe(200);

      const getResult = await s3.send(
        new GetObjectCommand({ Bucket: "rename-special", Key: "renamed.txt" }),
      );
      expect(await getResult.Body!.transformToString()).toBe("special");
    });
  });

  describe("spy events", () => {
    it("emits 'renamed' spy event", async () => {
      server.createBucket("rename-spy", { type: "directory" });
      await s3.send(
        new PutObjectCommand({ Bucket: "rename-spy", Key: "src.txt", Body: "spy-test" }),
      );
      server.spy.clear();

      const res = await renameObject(server.port, "rename-spy", "dest.txt", "src.txt");
      expect(res.status).toBe(200);

      const event = await server.spy.waitForMessage(
        { service: "s3", bucket: "rename-spy", key: "dest.txt", status: "renamed" },
        undefined,
        1000,
      );
      expect(event).toBeDefined();
    });
  });

  describe("init config", () => {
    it("creates directory bucket via init config object form", async () => {
      const dirServer = await startFauxqs({
        port: 0,
        logger: false,
        init: {
          buckets: [{ name: "init-dir-bucket", type: "directory" }, "init-gp-bucket"],
        },
      });
      const dirS3 = createS3Client(dirServer.port);

      try {
        // Put objects in both buckets
        await dirS3.send(
          new PutObjectCommand({ Bucket: "init-dir-bucket", Key: "test.txt", Body: "dir" }),
        );
        await dirS3.send(
          new PutObjectCommand({ Bucket: "init-gp-bucket", Key: "test.txt", Body: "gp" }),
        );

        // Rename should succeed on directory bucket
        const dirRes = await renameObject(
          dirServer.port,
          "init-dir-bucket",
          "renamed.txt",
          "test.txt",
        );
        expect(dirRes.status).toBe(200);

        // Rename should fail on general-purpose bucket
        const gpRes = await renameObject(
          dirServer.port,
          "init-gp-bucket",
          "renamed.txt",
          "test.txt",
        );
        expect(gpRes.status).toBe(400);
      } finally {
        dirS3.destroy();
        await dirServer.stop();
      }
    });
  });

  describe("CreateBucket with directory type via SDK", () => {
    it("creates directory bucket via CreateBucketConfiguration XML body", async () => {
      // Send raw PUT with CreateBucketConfiguration body
      const url = `http://127.0.0.1:${server.port}/sdk-dir-bucket`;
      const body = `<CreateBucketConfiguration><Bucket><Type>Directory</Type></Bucket></CreateBucketConfiguration>`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body,
      });
      expect(res.status).toBe(200);

      // Should be able to rename in this bucket
      await s3.send(
        new PutObjectCommand({ Bucket: "sdk-dir-bucket", Key: "src.txt", Body: "data" }),
      );
      const renameRes = await renameObject(
        server.port,
        "sdk-dir-bucket",
        "dest.txt",
        "src.txt",
      );
      expect(renameRes.status).toBe(200);
    });
  });
});
