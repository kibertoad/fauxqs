import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Multipart Part Retrieval (partNumber)", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const bucket = "part-retrieval-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("retrieves individual parts of a multipart upload", async () => {
    const key = "multipart-obj";
    const part1Body = Buffer.alloc(5 * 1024 * 1024, "a"); // 5 MiB
    const part2Body = Buffer.from("final part");

    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
    const etag1 = (await s3.send(new UploadPartCommand({
      Bucket: bucket, Key: key, UploadId, PartNumber: 1, Body: part1Body,
    }))).ETag;
    const etag2 = (await s3.send(new UploadPartCommand({
      Bucket: bucket, Key: key, UploadId, PartNumber: 2, Body: part2Body,
    }))).ETag;
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: key, UploadId,
      MultipartUpload: { Parts: [
        { PartNumber: 1, ETag: etag1 },
        { PartNumber: 2, ETag: etag2 },
      ]},
    }));

    // Get part 1
    const p1 = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, PartNumber: 1 }));
    const p1Body = await p1.Body!.transformToByteArray();
    expect(p1Body.length).toBe(5 * 1024 * 1024);
    expect(p1.PartsCount).toBe(2);

    // Get part 2
    const p2 = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, PartNumber: 2 }));
    const p2Body = await p2.Body!.transformToString();
    expect(p2Body).toBe("final part");
    expect(p2.PartsCount).toBe(2);
  });
});
