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

  /** Raw Multi-Object Delete, for bodies no SDK would serialise. */
  function rawDeleteObjects(targetBucket: string, body: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${server.port}/${targetBucket}?delete`, {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body,
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

    it("reports Size on a general-purpose bucket per object, sparing the rest of the batch", async () => {
      await put(bucket, "batch-gp-plain.txt", "v1");
      await put(bucket, "batch-gp-size.txt", "v1");

      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: [{ Key: "batch-gp-plain.txt" }, { Key: "batch-gp-size.txt", Size: 2 }],
          },
        }),
      );

      // The one object that asked for an unsupported precondition fails; a batch
      // is not aborted over it, so the unconditional sibling is still deleted.
      expect((result.Deleted ?? []).map((d) => d.Key)).toEqual(["batch-gp-plain.txt"]);
      expect(result.Errors).toHaveLength(1);
      expect(result.Errors![0]).toMatchObject({
        Key: "batch-gp-size.txt",
        Code: "NotImplemented",
      });
      expect(result.Errors![0].Message).toContain("Size");
      expect(await exists(bucket, "batch-gp-plain.txt")).toBe(false);
      expect(await exists(bucket, "batch-gp-size.txt")).toBe(true);
    });
  });

  describe("DeleteObjects body parsing", () => {
    it("still deletes keys in a body that omits the <Object> wrapper", async () => {
      await put(bucket, "loose-one.txt", "v1");
      await put(bucket, "loose-two.txt", "v1");

      // Hand-written XML the SDKs never emit, but which fauxqs accepted before
      // per-object preconditions arrived. Reporting 200 while deleting nothing
      // would be the worst way to drop support for it.
      const res = await rawDeleteObjects(
        bucket,
        "<Delete><Key>loose-one.txt</Key><Key>loose-two.txt</Key></Delete>",
      );

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("loose-one.txt");
      expect(body).toContain("loose-two.txt");
      expect(await exists(bucket, "loose-one.txt")).toBe(false);
      expect(await exists(bucket, "loose-two.txt")).toBe(false);
    });

    it("rejects an <Object> entry with no key as MalformedXML", async () => {
      await put(bucket, "keyless-sibling.txt", "v1");

      const res = await rawDeleteObjects(
        bucket,
        "<Delete><Object><ETag>*</ETag></Object>" +
          "<Object><Key>keyless-sibling.txt</Key></Object></Delete>",
      );

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("MalformedXML");
      // A dropped entry must not be reported as a partial success.
      expect(await exists(bucket, "keyless-sibling.txt")).toBe(true);
    });

    it("rejects a body whose root element is not closed, deleting nothing", async () => {
      await put(bucket, "truncated-root.txt", "v1");

      // Element extraction alone reads this as a complete one-key request, so the
      // key would be deleted under a 200 OK. Real S3 answers MalformedXML.
      const res = await rawDeleteObjects(
        bucket,
        "<Delete><Object><Key>truncated-root.txt</Key></Object>",
      );

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("MalformedXML");
      expect(await exists(bucket, "truncated-root.txt")).toBe(true);
    });

    it("rejects a body whose last <Object> entry is truncated, deleting nothing", async () => {
      await put(bucket, "truncated-first.txt", "v1");
      await put(bucket, "truncated-last.txt", "v1");

      const res = await rawDeleteObjects(
        bucket,
        "<Delete><Object><Key>truncated-first.txt</Key></Object>" +
          "<Object><Key>truncated-last.txt</Key></Delete>",
      );

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("MalformedXML");
      // Deleting the entries that did survive the truncation would report a
      // partial success with no sign the rest of the batch was dropped.
      expect(await exists(bucket, "truncated-first.txt")).toBe(true);
      expect(await exists(bucket, "truncated-last.txt")).toBe(true);
    });

    it("fails the whole request on a malformed <Size>, deleting nothing", async () => {
      await put(dirBucket, "batch-bad-size.txt", "v1");
      await put(dirBucket, "batch-bad-size-sibling.txt", "v1");

      const res = await rawDeleteObjects(
        dirBucket,
        "<Delete><Object><Key>batch-bad-size-sibling.txt</Key></Object>" +
          "<Object><Key>batch-bad-size.txt</Key><Size>not-a-number</Size></Object></Delete>",
      );

      // A value that cannot be parsed is a bad request, not a per-object verdict
      // under a 200, and it is caught before the batch is half applied.
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("InvalidArgument");
      expect(await exists(dirBucket, "batch-bad-size.txt")).toBe(true);
      expect(await exists(dirBucket, "batch-bad-size-sibling.txt")).toBe(true);
    });
  });

  describe("last-modified-time wire formats", () => {
    it("accepts an RFC-3339 timestamp with an explicit offset", async () => {
      await put(dirBucket, "iso-offset.txt", "v1");
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: dirBucket, Key: "iso-offset.txt" }),
      );

      const res = await rawDelete(dirBucket, "iso-offset.txt", {
        "x-amz-if-match-last-modified-time": head.LastModified!.toISOString(),
      });

      expect(res.status).toBe(204);
      expect(await exists(dirBucket, "iso-offset.txt")).toBe(false);
    });

    it("rejects a timestamp with no offset, which would otherwise read as local time", async () => {
      await put(dirBucket, "iso-naive.txt", "v1");
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: dirBucket, Key: "iso-naive.txt" }),
      );

      // The correct instant, spelled without a zone: Date.parse would read it in
      // the host's timezone, so the same request would pass on a UTC box and 412
      // anywhere else.
      const res = await rawDelete(dirBucket, "iso-naive.txt", {
        "x-amz-if-match-last-modified-time": head.LastModified!.toISOString().replace("Z", ""),
      });

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("InvalidArgument");
      expect(await exists(dirBucket, "iso-naive.txt")).toBe(true);
    });

    it("rejects a value that is not a timestamp at all", async () => {
      await put(dirBucket, "lmt-garbage.txt", "v1");

      // Date.parse reads "999" as the year 999, which would surface as a plain
      // 412 and send the caller hunting for clock drift that isn't there.
      const res = await rawDelete(dirBucket, "lmt-garbage.txt", {
        "x-amz-if-match-last-modified-time": "999",
      });

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("InvalidArgument");
      expect(await exists(dirBucket, "lmt-garbage.txt")).toBe(true);
    });
  });

  describe("If-Match header shapes", () => {
    it("treats a blank If-Match as a precondition, the way a write does", async () => {
      await put(bucket, "blank-if-match.txt", "v1");

      // Reading a blank value as "no precondition sent" would silently delete on
      // a request that PutObject answers with a 412. It matches no ETag, so it
      // cannot hold.
      const res = await rawDelete(bucket, "blank-if-match.txt", { "if-match": "" });

      expect(res.status).toBe(412);
      expect(await exists(bucket, "blank-if-match.txt")).toBe(true);
    });

    it("applies the empty-key rule to a blank If-Match too", async () => {
      const res = await rawDelete(bucket, "blank-if-match-missing.txt", { "if-match": "" });

      // A concrete If-Match against a key that holds nothing is a 404, not a 412.
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("NoSuchKey");
    });
  });

  describe("DeleteObject bucket resolution", () => {
    it("reports NoSuchBucket ahead of an unsupported directory-only header", async () => {
      // An absent bucket is not a directory bucket, but it is not a
      // general-purpose one either — resolving it has to come first.
      const res = await rawDelete("no-such-bucket-at-all", "k.txt", {
        "x-amz-if-match-size": "5",
      });

      expect(res.status).toBe(404);
      expect(await res.text()).toContain("NoSuchBucket");
    });
  });
});
