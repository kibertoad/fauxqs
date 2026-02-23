import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectAttributesCommand,
  ObjectAttributes,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 GetObjectAttributes", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const bucket = "get-obj-attrs-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("returns basic attributes (ETag, ObjectSize, StorageClass)", async () => {
    const body = "hello world";
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "basic.txt", Body: body }));

    const result = await s3.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: "basic.txt",
        ObjectAttributes: [ObjectAttributes.ETAG, ObjectAttributes.OBJECT_SIZE, ObjectAttributes.STORAGE_CLASS],
      }),
    );

    expect(result.ETag).toBeDefined();
    expect(result.ETag).not.toContain('"');
    expect(result.ObjectSize).toBe(body.length);
    expect(result.StorageClass).toBe("STANDARD");
  });

  it("returns only requested attributes", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "selective.txt", Body: "data" }));

    const result = await s3.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: "selective.txt",
        ObjectAttributes: [ObjectAttributes.ETAG],
      }),
    );

    expect(result.ETag).toBeDefined();
    expect(result.ObjectSize).toBeUndefined();
    expect(result.StorageClass).toBeUndefined();
    expect(result.ObjectParts).toBeUndefined();
  });

  it("returns ObjectParts for multipart uploads", async () => {
    const key = "multipart-attrs";
    const part1Body = Buffer.alloc(5 * 1024 * 1024, "a");
    const part2Body = Buffer.from("final part");

    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    const etag1 = (
      await s3.send(
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: 1, Body: part1Body }),
      )
    ).ETag;
    const etag2 = (
      await s3.send(
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: 2, Body: part2Body }),
      )
    ).ETag;
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: etag1 },
            { PartNumber: 2, ETag: etag2 },
          ],
        },
      }),
    );

    const result = await s3.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: key,
        ObjectAttributes: [ObjectAttributes.OBJECT_PARTS],
      }),
    );

    expect(result.ObjectParts).toBeDefined();
    expect(result.ObjectParts!.TotalPartsCount).toBe(2);
    expect(result.ObjectParts!.Parts).toHaveLength(2);
    expect(result.ObjectParts!.Parts![0].PartNumber).toBe(1);
    expect(result.ObjectParts!.Parts![0].Size).toBe(5 * 1024 * 1024);
    expect(result.ObjectParts!.Parts![1].PartNumber).toBe(2);
    expect(result.ObjectParts!.Parts![1].Size).toBe(part2Body.length);
  });

  it("paginates ObjectParts with MaxParts", async () => {
    const key = "multipart-paginate";
    const part1Body = Buffer.alloc(5 * 1024 * 1024, "a");
    const part2Body = Buffer.from("final");

    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    const etag1 = (
      await s3.send(
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: 1, Body: part1Body }),
      )
    ).ETag;
    const etag2 = (
      await s3.send(
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: 2, Body: part2Body }),
      )
    ).ETag;
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: etag1 },
            { PartNumber: 2, ETag: etag2 },
          ],
        },
      }),
    );

    const result = await s3.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: key,
        ObjectAttributes: [ObjectAttributes.OBJECT_PARTS],
        MaxParts: 1,
      }),
    );

    expect(result.ObjectParts!.IsTruncated).toBe(true);
    expect(result.ObjectParts!.Parts).toHaveLength(1);
    expect(result.ObjectParts!.Parts![0].PartNumber).toBe(1);
    expect(Number(result.ObjectParts!.NextPartNumberMarker)).toBe(1);
  });

  it("paginates ObjectParts with PartNumberMarker", async () => {
    const key = "multipart-marker";
    const part1Body = Buffer.alloc(5 * 1024 * 1024, "x");
    const part2Body = Buffer.from("end");

    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    const etag1 = (
      await s3.send(
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: 1, Body: part1Body }),
      )
    ).ETag;
    const etag2 = (
      await s3.send(
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: 2, Body: part2Body }),
      )
    ).ETag;
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: etag1 },
            { PartNumber: 2, ETag: etag2 },
          ],
        },
      }),
    );

    const result = await s3.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: key,
        ObjectAttributes: [ObjectAttributes.OBJECT_PARTS],
        PartNumberMarker: 1,
      }),
    );

    expect(result.ObjectParts!.IsTruncated).toBe(false);
    expect(result.ObjectParts!.Parts).toHaveLength(1);
    expect(result.ObjectParts!.Parts![0].PartNumber).toBe(2);
    expect(Number(result.ObjectParts!.PartNumberMarker)).toBe(1);
    expect(Number(result.ObjectParts!.NextPartNumberMarker)).toBe(2);
  });

  it("returns undefined ObjectParts for non-multipart objects", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "regular.txt", Body: "data" }));

    const result = await s3.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: "regular.txt",
        ObjectAttributes: [ObjectAttributes.OBJECT_PARTS],
      }),
    );

    expect(result.ObjectParts).toBeUndefined();
  });

  it("throws NoSuchKey for missing key", async () => {
    await expect(
      s3.send(
        new GetObjectAttributesCommand({
          Bucket: bucket,
          Key: "nonexistent.txt",
          ObjectAttributes: [ObjectAttributes.ETAG],
        }),
      ),
    ).rejects.toThrow(/specified key does not exist/);
  });

  it("throws error for missing bucket", async () => {
    await expect(
      s3.send(
        new GetObjectAttributesCommand({
          Bucket: "no-such-bucket-xyz",
          Key: "key.txt",
          ObjectAttributes: [ObjectAttributes.ETAG],
        }),
      ),
    ).rejects.toThrow();
  });

  it("includes LastModified in response", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "dated.txt", Body: "test" }));

    const result = await s3.send(
      new GetObjectAttributesCommand({
        Bucket: bucket,
        Key: "dated.txt",
        ObjectAttributes: [ObjectAttributes.ETAG],
      }),
    );

    expect(result.LastModified).toBeInstanceOf(Date);
  });
});
