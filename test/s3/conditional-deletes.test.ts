import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

const bucket = "cond-delete-bucket";
const dirBucket = "cond-delete-dir-bucket";
const WRONG_ETAG = '"00000000000000000000000000000000"';

describe("S3 Conditional Deletes", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    server.createBucket(bucket);
    server.createBucket(dirBucket, { type: "directory" });
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  /** Store an object and hand back its ETag and byte size. */
  async function put(
    targetBucket: string,
    key: string,
    body: string,
  ): Promise<{ etag: string; size: number }> {
    const res = await s3.send(new PutObjectCommand({ Bucket: targetBucket, Key: key, Body: body }));
    return { etag: res.ETag!, size: Buffer.byteLength(body) };
  }

  async function exists(targetBucket: string, key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: targetBucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Raw DeleteObject request, used for the two directory-bucket preconditions:
   * fetch keeps the documented header wire format in view instead of leaving the
   * timestamp and size formatting to the SDK.
   */
  function rawDelete(
    targetBucket: string,
    key: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${server.port}/${targetBucket}/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers,
    });
  }

  describe("DeleteObject If-Match", () => {
    it("deletes when the ETag matches", async () => {
      const { etag } = await put(bucket, "ifm-match.txt", "v1");

      await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: "ifm-match.txt", IfMatch: etag }),
      );

      expect(await exists(bucket, "ifm-match.txt")).toBe(false);
    });

    it("fails with 412 and keeps the object when the ETag does not match", async () => {
      await put(bucket, "ifm-stale.txt", "v1");

      await expect(
        s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: "ifm-stale.txt",
            IfMatch: WRONG_ETAG,
          }),
        ),
      ).rejects.toMatchObject({
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      });

      expect(await exists(bucket, "ifm-stale.txt")).toBe(true);
    });

    it("accepts an unquoted ETag", async () => {
      const { etag } = await put(bucket, "ifm-unquoted.txt", "v1");

      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: "ifm-unquoted.txt",
          IfMatch: etag.replaceAll('"', ""),
        }),
      );

      expect(await exists(bucket, "ifm-unquoted.txt")).toBe(false);
    });

    it("deletes when any tag in a comma-separated list matches", async () => {
      const { etag } = await put(bucket, "ifm-list.txt", "v1");

      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: "ifm-list.txt",
          IfMatch: `${WRONG_ETAG}, ${etag}`,
        }),
      );

      expect(await exists(bucket, "ifm-list.txt")).toBe(false);
    });

    it("fails with 404 when the key does not exist", async () => {
      await expect(
        s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: "ifm-missing.txt",
            IfMatch: WRONG_ETAG,
          }),
        ),
      ).rejects.toMatchObject({ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    });

    it("reports NoSuchBucket rather than a precondition failure for an unknown bucket", async () => {
      await expect(
        s3.send(
          new DeleteObjectCommand({
            Bucket: "cond-delete-no-such-bucket",
            Key: "any.txt",
            IfMatch: WRONG_ETAG,
          }),
        ),
      ).rejects.toMatchObject({ name: "NoSuchBucket" });
    });

    it("still deletes a missing key with a 204 when no precondition is sent", async () => {
      const res = await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: "unconditional-missing.txt" }),
      );
      expect(res.$metadata.httpStatusCode).toBe(204);
    });
  });

  describe("DeleteObject If-Match: *", () => {
    it("deletes when the object exists", async () => {
      await put(bucket, "star-exists.txt", "v1");

      await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: "star-exists.txt", IfMatch: "*" }),
      );

      expect(await exists(bucket, "star-exists.txt")).toBe(false);
    });

    it("fails with 412 when the object does not exist", async () => {
      await expect(
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "star-missing.txt", IfMatch: "*" })),
      ).rejects.toMatchObject({
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      });
    });
  });

  describe("DeleteObject directory-bucket preconditions", () => {
    it("deletes when the size matches", async () => {
      const { size } = await put(dirBucket, "size-match.txt", "twelve bytes");

      const res = await rawDelete(dirBucket, "size-match.txt", {
        "x-amz-if-match-size": String(size),
      });

      expect(res.status).toBe(204);
      expect(await exists(dirBucket, "size-match.txt")).toBe(false);
    });

    it("fails with 412 when the size does not match", async () => {
      await put(dirBucket, "size-stale.txt", "v1");

      const res = await rawDelete(dirBucket, "size-stale.txt", {
        "x-amz-if-match-size": "999",
      });

      expect(res.status).toBe(412);
      expect(await res.text()).toContain("PreconditionFailed");
      expect(await exists(dirBucket, "size-stale.txt")).toBe(true);
    });

    it("deletes when the last-modified time matches", async () => {
      await put(dirBucket, "lmt-match.txt", "v1");
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: dirBucket, Key: "lmt-match.txt" }),
      );

      const res = await rawDelete(dirBucket, "lmt-match.txt", {
        "x-amz-if-match-last-modified-time": head.LastModified!.toUTCString(),
      });

      expect(res.status).toBe(204);
      expect(await exists(dirBucket, "lmt-match.txt")).toBe(false);
    });

    it("fails with 412 when the last-modified time does not match", async () => {
      await put(dirBucket, "lmt-stale.txt", "v1");

      const res = await rawDelete(dirBucket, "lmt-stale.txt", {
        "x-amz-if-match-last-modified-time": new Date(0).toUTCString(),
      });

      expect(res.status).toBe(412);
      expect(await exists(dirBucket, "lmt-stale.txt")).toBe(true);
    });

    it("returns 204 for a missing key, since size and time cannot disagree", async () => {
      const res = await rawDelete(dirBucket, "size-missing.txt", {
        "x-amz-if-match-size": "5",
        "x-amz-if-match-last-modified-time": new Date(0).toUTCString(),
      });

      expect(res.status).toBe(204);
    });

    it("evaluates If-Match alongside size", async () => {
      const { etag, size } = await put(dirBucket, "combined.txt", "v1");

      const mismatch = await rawDelete(dirBucket, "combined.txt", {
        "if-match": etag,
        "x-amz-if-match-size": String(size + 1),
      });
      expect(mismatch.status).toBe(412);

      const match = await rawDelete(dirBucket, "combined.txt", {
        "if-match": etag,
        "x-amz-if-match-size": String(size),
      });
      expect(match.status).toBe(204);
    });

    it("rejects a malformed size with 400", async () => {
      await put(dirBucket, "bad-size.txt", "v1");

      const res = await rawDelete(dirBucket, "bad-size.txt", {
        "x-amz-if-match-size": "not-a-number",
      });

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("InvalidArgument");
    });

    it("rejects the directory-only headers on a general-purpose bucket with 501", async () => {
      await put(bucket, "gp-size.txt", "v1");

      const res = await rawDelete(bucket, "gp-size.txt", { "x-amz-if-match-size": "2" });

      expect(res.status).toBe(501);
      const body = await res.text();
      expect(body).toContain("NotImplemented");
      expect(body).toContain("x-amz-if-match-size");
      expect(await exists(bucket, "gp-size.txt")).toBe(true);
    });
  });

  describe("DeleteObjects per-object ETag", () => {
    it("deletes matching keys and reports mismatches as per-key errors", async () => {
      const stale = await put(bucket, "batch-stale.txt", "v1");
      await put(bucket, "batch-stale.txt", "v2");
      const fresh = await put(bucket, "batch-fresh.txt", "v1");
      await put(bucket, "batch-plain.txt", "v1");

      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: [
              { Key: "batch-stale.txt", ETag: stale.etag },
              { Key: "batch-fresh.txt", ETag: fresh.etag },
              { Key: "batch-plain.txt" },
            ],
          },
        }),
      );

      expect((result.Deleted ?? []).map((d) => d.Key).sort()).toEqual([
        "batch-fresh.txt",
        "batch-plain.txt",
      ]);
      expect(result.Errors).toHaveLength(1);
      expect(result.Errors![0]).toMatchObject({
        Key: "batch-stale.txt",
        Code: "PreconditionFailed",
      });

      // Only the keys whose preconditions held are gone.
      expect(await exists(bucket, "batch-stale.txt")).toBe(true);
      expect(await exists(bucket, "batch-fresh.txt")).toBe(false);
      expect(await exists(bucket, "batch-plain.txt")).toBe(false);
    });

    it("treats ETag * as an existence check", async () => {
      await put(bucket, "batch-star-exists.txt", "v1");

      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: [
              { Key: "batch-star-exists.txt", ETag: "*" },
              { Key: "batch-star-missing.txt", ETag: "*" },
            ],
          },
        }),
      );

      expect((result.Deleted ?? []).map((d) => d.Key)).toEqual(["batch-star-exists.txt"]);
      expect(result.Errors).toHaveLength(1);
      expect(result.Errors![0]).toMatchObject({
        Key: "batch-star-missing.txt",
        Code: "PreconditionFailed",
      });
    });

    it("reports NoSuchKey for a concrete ETag against a missing key", async () => {
      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: [{ Key: "batch-gone.txt", ETag: WRONG_ETAG }] },
        }),
      );

      expect(result.Deleted ?? []).toHaveLength(0);
      expect(result.Errors).toHaveLength(1);
      expect(result.Errors![0]).toMatchObject({ Key: "batch-gone.txt", Code: "NoSuchKey" });
    });

    it("returns errors in quiet mode while suppressing the successes", async () => {
      await put(bucket, "quiet-ok.txt", "v1");
      const ok = await put(bucket, "quiet-ok.txt", "v2");
      await put(bucket, "quiet-bad.txt", "v1");

      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: [
              { Key: "quiet-ok.txt", ETag: ok.etag },
              { Key: "quiet-bad.txt", ETag: WRONG_ETAG },
            ],
            Quiet: true,
          },
        }),
      );

      expect(result.Deleted ?? []).toHaveLength(0);
      expect(result.Errors).toHaveLength(1);
      expect(result.Errors![0]).toMatchObject({
        Key: "quiet-bad.txt",
        Code: "PreconditionFailed",
      });
      expect(await exists(bucket, "quiet-ok.txt")).toBe(false);
      expect(await exists(bucket, "quiet-bad.txt")).toBe(true);
    });

    it("honours Size and LastModifiedTime on a directory bucket", async () => {
      const { size } = await put(dirBucket, "batch-size.txt", "twelve bytes");
      await put(dirBucket, "batch-size-stale.txt", "v1");
      await put(dirBucket, "batch-lmt.txt", "v1");
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: dirBucket, Key: "batch-lmt.txt" }),
      );

      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: dirBucket,
          Delete: {
            Objects: [
              { Key: "batch-size.txt", Size: size },
              { Key: "batch-size-stale.txt", Size: 999 },
              { Key: "batch-lmt.txt", LastModifiedTime: head.LastModified },
            ],
          },
        }),
      );

      expect((result.Deleted ?? []).map((d) => d.Key).sort()).toEqual([
        "batch-lmt.txt",
        "batch-size.txt",
      ]);
      expect(result.Errors).toHaveLength(1);
      expect(result.Errors![0]).toMatchObject({
        Key: "batch-size-stale.txt",
        Code: "PreconditionFailed",
      });
    });

    it("rejects Size on a general-purpose bucket without deleting anything", async () => {
      await put(bucket, "batch-gp-plain.txt", "v1");
      await put(bucket, "batch-gp-size.txt", "v1");

      await expect(
        s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: [{ Key: "batch-gp-plain.txt" }, { Key: "batch-gp-size.txt", Size: 2 }],
            },
          }),
        ),
      ).rejects.toMatchObject({ name: "NotImplemented" });

      // The whole request is rejected, so the unconditional key survives too.
      expect(await exists(bucket, "batch-gp-plain.txt")).toBe(true);
      expect(await exists(bucket, "batch-gp-size.txt")).toBe(true);
    });
  });
});
