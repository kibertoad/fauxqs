import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  GetObjectAttributesCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  ChecksumAlgorithm,
  ChecksumMode,
  ObjectAttributes,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Checksums", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const bucket = "checksum-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("PutObject stores and returns CRC32 checksum (SDK default)", async () => {
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "crc32-default.txt",
        Body: "hello world",
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );

    expect(result.ChecksumCRC32).toBeDefined();
    expect(result.ChecksumCRC32!.length).toBeGreaterThan(0);
  });

  it("GetObject returns checksum when x-amz-checksum-mode: ENABLED", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "get-checksum.txt",
        Body: "test data",
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );

    const result = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: "get-checksum.txt",
        ChecksumMode: ChecksumMode.ENABLED,
      }),
    );

    expect(result.ChecksumCRC32).toBeDefined();
    // Consume body to prevent connection leak
    await result.Body!.transformToString();
  });

  it("GetObject omits checksum without mode header", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "no-mode.txt",
        Body: "test",
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );

    // Make raw HTTP request without checksum mode header
    const response = await fetch(
      `http://127.0.0.1:${server.port}/checksum-bucket/no-mode.txt`,
    );
    const headers = Object.fromEntries(response.headers.entries());
    expect(headers["x-amz-checksum-crc32"]).toBeUndefined();
    await response.text();
  });

  it("HeadObject returns checksum when mode ENABLED", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "head-checksum.txt",
        Body: "head test",
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );

    const result = await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: "head-checksum.txt",
        ChecksumMode: ChecksumMode.ENABLED,
      }),
    );

    expect(result.ChecksumCRC32).toBeDefined();
  });

  it("GetObjectAttributes returns Checksum", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "attrs-checksum.txt",
        Body: "attributes test",
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );

    const result = await s3.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: "attrs-checksum.txt",
        ObjectAttributes: [ObjectAttributes.CHECKSUM],
      }),
    );

    expect(result.Checksum).toBeDefined();
    expect(result.Checksum!.ChecksumCRC32).toBeDefined();
  });

  it("CopyObject preserves checksum (COPY directive)", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "copy-src.txt",
        Body: "copy me",
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );

    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: "copy-dst.txt",
        CopySource: `${bucket}/copy-src.txt`,
      }),
    );

    const result = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: "copy-dst.txt",
        ChecksumMode: ChecksumMode.ENABLED,
      }),
    );

    expect(result.ChecksumCRC32).toBeDefined();
    await result.Body!.transformToString();
  });

  it("multipart upload with checksums returns composite", async () => {
    const key = "multipart-checksum";
    const part1Body = Buffer.alloc(5 * 1024 * 1024, "a");
    const part2Body = Buffer.from("final part data");

    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );

    const upload1 = await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        PartNumber: 1,
        Body: part1Body,
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );
    expect(upload1.ChecksumCRC32).toBeDefined();

    const upload2 = await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        PartNumber: 2,
        Body: part2Body,
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );
    expect(upload2.ChecksumCRC32).toBeDefined();

    const complete = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: upload1.ETag, ChecksumCRC32: upload1.ChecksumCRC32 },
            { PartNumber: 2, ETag: upload2.ETag, ChecksumCRC32: upload2.ChecksumCRC32 },
          ],
        },
      }),
    );

    // Composite checksum has format "base64-N"
    expect(complete.ChecksumCRC32).toBeDefined();
    expect(complete.ChecksumCRC32).toMatch(/-2$/);
  });

  it("GetObjectAttributes shows per-part checksums for multipart", async () => {
    const key = "multipart-part-checksums";
    const part1Body = Buffer.alloc(5 * 1024 * 1024, "b");
    const part2Body = Buffer.from("second part");

    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );

    const upload1 = await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        PartNumber: 1,
        Body: part1Body,
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );
    const upload2 = await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        PartNumber: 2,
        Body: part2Body,
        ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
      }),
    );

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: upload1.ETag, ChecksumCRC32: upload1.ChecksumCRC32 },
            { PartNumber: 2, ETag: upload2.ETag, ChecksumCRC32: upload2.ChecksumCRC32 },
          ],
        },
      }),
    );

    const result = await s3.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: key,
        ObjectAttributes: [ObjectAttributes.CHECKSUM, ObjectAttributes.OBJECT_PARTS],
      }),
    );

    expect(result.Checksum).toBeDefined();
    expect(result.Checksum!.ChecksumCRC32).toMatch(/-2$/);
    expect(result.ObjectParts).toBeDefined();
    expect(result.ObjectParts!.Parts).toHaveLength(2);
    expect(result.ObjectParts!.Parts![0].ChecksumCRC32).toBe(upload1.ChecksumCRC32);
    expect(result.ObjectParts!.Parts![1].ChecksumCRC32).toBe(upload2.ChecksumCRC32);
  });

  it("SHA256 checksum round-trip", async () => {
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "sha256.txt",
        Body: "sha256 test data",
        ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
      }),
    );

    expect(result.ChecksumSHA256).toBeDefined();

    const getResult = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: "sha256.txt",
        ChecksumMode: ChecksumMode.ENABLED,
      }),
    );

    expect(getResult.ChecksumSHA256).toBeDefined();
    expect(getResult.ChecksumSHA256).toBe(result.ChecksumSHA256);
    await getResult.Body!.transformToString();
  });

  it("SHA1 checksum round-trip", async () => {
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "sha1.txt",
        Body: "sha1 test data",
        ChecksumAlgorithm: ChecksumAlgorithm.SHA1,
      }),
    );

    expect(result.ChecksumSHA1).toBeDefined();

    const getResult = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: "sha1.txt",
        ChecksumMode: ChecksumMode.ENABLED,
      }),
    );

    expect(getResult.ChecksumSHA1).toBeDefined();
    expect(getResult.ChecksumSHA1).toBe(result.ChecksumSHA1);
    await getResult.Body!.transformToString();
  });
});
