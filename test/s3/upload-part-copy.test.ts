import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 UploadPartCopy", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const srcBucket = "copy-part-src";
  const dstBucket = "copy-part-dst";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: srcBucket }));
    await s3.send(new CreateBucketCommand({ Bucket: dstBucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("copies an existing object as a multipart part", async () => {
    const sourceData = Buffer.alloc(5 * 1024 * 1024, "x");
    await s3.send(new PutObjectCommand({ Bucket: srcBucket, Key: "source-obj", Body: sourceData }));

    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
      Bucket: dstBucket, Key: "dest-obj",
    }));

    const copyResult = await s3.send(new UploadPartCopyCommand({
      Bucket: dstBucket, Key: "dest-obj", UploadId, PartNumber: 1,
      CopySource: `${srcBucket}/source-obj`,
    }));
    expect(copyResult.CopyPartResult?.ETag).toBeDefined();

    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: dstBucket, Key: "dest-obj", UploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: copyResult.CopyPartResult!.ETag }] },
    }));

    const obj = await s3.send(new GetObjectCommand({ Bucket: dstBucket, Key: "dest-obj" }));
    const body = await obj.Body!.transformToByteArray();
    expect(body.length).toBe(5 * 1024 * 1024);
  });

  it("copies a byte range from source object", async () => {
    const sourceData = Buffer.from("0123456789ABCDEF");
    await s3.send(new PutObjectCommand({ Bucket: srcBucket, Key: "range-source", Body: sourceData }));

    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
      Bucket: dstBucket, Key: "range-dest",
    }));

    // Copy bytes 5-9 (inclusive)
    const copyResult = await s3.send(new UploadPartCopyCommand({
      Bucket: dstBucket, Key: "range-dest", UploadId, PartNumber: 1,
      CopySource: `${srcBucket}/range-source`,
      CopySourceRange: "bytes=5-9",
    }));
    expect(copyResult.CopyPartResult?.ETag).toBeDefined();

    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: dstBucket, Key: "range-dest", UploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: copyResult.CopyPartResult!.ETag }] },
    }));

    const obj = await s3.send(new GetObjectCommand({ Bucket: dstBucket, Key: "range-dest" }));
    const body = await obj.Body!.transformToString();
    expect(body).toBe("56789");
  });

  it("copies across buckets", async () => {
    await s3.send(new PutObjectCommand({
      Bucket: srcBucket, Key: "cross-bucket-src",
      Body: Buffer.alloc(5 * 1024 * 1024, "z"),
    }));

    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
      Bucket: dstBucket, Key: "cross-bucket-dest",
    }));

    const copyResult = await s3.send(new UploadPartCopyCommand({
      Bucket: dstBucket, Key: "cross-bucket-dest", UploadId, PartNumber: 1,
      CopySource: `${srcBucket}/cross-bucket-src`,
    }));

    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: dstBucket, Key: "cross-bucket-dest", UploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: copyResult.CopyPartResult!.ETag }] },
    }));

    const obj = await s3.send(new GetObjectCommand({ Bucket: dstBucket, Key: "cross-bucket-dest" }));
    const body = await obj.Body!.transformToByteArray();
    expect(body.length).toBe(5 * 1024 * 1024);
  });

  it("returns NoSuchKey when copy source does not exist", async () => {
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
      Bucket: dstBucket, Key: "fail-dest",
    }));
    await expect(
      s3.send(new UploadPartCopyCommand({
        Bucket: dstBucket, Key: "fail-dest", UploadId, PartNumber: 1,
        CopySource: `${srcBucket}/nonexistent-key`,
      }))
    ).rejects.toThrow(/specified key does not exist/);
  });
});
