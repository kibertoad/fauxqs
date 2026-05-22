import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

const bucket = "cond-write-bucket";

describe("S3 Conditional Writes", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  async function getBody(key: string): Promise<string> {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return r.Body!.transformToString();
  }

  describe("PutObject", () => {
    it("If-None-Match: * succeeds when the key does not exist", async () => {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: "inm-new.txt",
          Body: "first write",
          IfNoneMatch: "*",
        }),
      );
      expect(await getBody("inm-new.txt")).toBe("first write");
    });

    it("If-None-Match: * fails with 412 when the key already exists", async () => {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: "inm-exists.txt", Body: "original" }),
      );

      await expect(
        s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: "inm-exists.txt",
            Body: "overwrite attempt",
            IfNoneMatch: "*",
          }),
        ),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });

      // The original object is untouched
      expect(await getBody("inm-exists.txt")).toBe("original");
    });

    it("If-Match succeeds when the ETag matches (compare-and-swap)", async () => {
      const put = await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: "ifm-cas.txt", Body: "v1" }),
      );

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: "ifm-cas.txt",
          Body: "v2",
          IfMatch: put.ETag,
        }),
      );
      expect(await getBody("ifm-cas.txt")).toBe("v2");
    });

    it("If-Match fails with 412 when the ETag does not match", async () => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "ifm-stale.txt", Body: "v1" }));

      await expect(
        s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: "ifm-stale.txt",
            Body: "v2",
            IfMatch: '"deadbeefdeadbeefdeadbeefdeadbeef"',
          }),
        ),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });

      expect(await getBody("ifm-stale.txt")).toBe("v1");
    });

    it("If-Match fails with 412 when the key does not exist", async () => {
      await expect(
        s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: "ifm-missing.txt",
            Body: "data",
            IfMatch: '"deadbeefdeadbeefdeadbeefdeadbeef"',
          }),
        ),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    });
  });

  describe("CompleteMultipartUpload", () => {
    it("If-None-Match: * fails with 412 when the key already exists", async () => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "mpu-exists.txt", Body: "taken" }));

      const { UploadId } = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: "mpu-exists.txt" }),
      );
      const part = await s3.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: "mpu-exists.txt",
          UploadId,
          PartNumber: 1,
          Body: "multipart body",
        }),
      );

      await expect(
        s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: "mpu-exists.txt",
            UploadId,
            IfNoneMatch: "*",
            MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] },
          }),
        ),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });

      expect(await getBody("mpu-exists.txt")).toBe("taken");
    });

    it("If-None-Match: * succeeds for a new key", async () => {
      const { UploadId } = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: "mpu-new.txt" }),
      );
      const part = await s3.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: "mpu-new.txt",
          UploadId,
          PartNumber: 1,
          Body: "fresh multipart body",
        }),
      );

      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: "mpu-new.txt",
          UploadId,
          IfNoneMatch: "*",
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] },
        }),
      );
      expect(await getBody("mpu-new.txt")).toBe("fresh multipart body");
    });
  });

  describe("CopyObject", () => {
    it("If-None-Match: * fails with 412 when the destination already exists", async () => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "copy-src.txt", Body: "source" }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "copy-dst.txt", Body: "dest" }));

      await expect(
        s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: "copy-dst.txt",
            CopySource: `${bucket}/copy-src.txt`,
            IfNoneMatch: "*",
          }),
        ),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });

      expect(await getBody("copy-dst.txt")).toBe("dest");
    });

    it("If-Match succeeds when the destination ETag matches", async () => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "copy-src2.txt", Body: "payload" }));
      const dst = await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: "copy-dst2.txt", Body: "old dest" }),
      );

      await s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: "copy-dst2.txt",
          CopySource: `${bucket}/copy-src2.txt`,
          IfMatch: dst.ETag,
        }),
      );
      expect(await getBody("copy-dst2.txt")).toBe("payload");
    });
  });
});
