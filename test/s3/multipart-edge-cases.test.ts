import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Multipart Upload Edge Cases", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "edge-case-bucket" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("rejects completion when ETag does not match uploaded part", async () => {
    const init = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: "edge-case-bucket",
        Key: "etag-mismatch.txt",
      }),
    );

    await s3.send(
      new UploadPartCommand({
        Bucket: "edge-case-bucket",
        Key: "etag-mismatch.txt",
        UploadId: init.UploadId,
        PartNumber: 1,
        Body: "actual data",
      }),
    );

    // Complete with a wrong ETag
    await expect(
      s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "edge-case-bucket",
          Key: "etag-mismatch.txt",
          UploadId: init.UploadId,
          MultipartUpload: {
            Parts: [{ PartNumber: 1, ETag: '"0000000000000000000000000000dead"' }],
          },
        }),
      ),
    ).rejects.toThrow();

    // Clean up
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: "edge-case-bucket",
        Key: "etag-mismatch.txt",
        UploadId: init.UploadId,
      }),
    );
  });

  it("rejects completion when parts are not in ascending order", async () => {
    const init = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: "edge-case-bucket",
        Key: "out-of-order.txt",
      }),
    );

    const part1 = await s3.send(
      new UploadPartCommand({
        Bucket: "edge-case-bucket",
        Key: "out-of-order.txt",
        UploadId: init.UploadId,
        PartNumber: 1,
        Body: "part-1",
      }),
    );

    const part2 = await s3.send(
      new UploadPartCommand({
        Bucket: "edge-case-bucket",
        Key: "out-of-order.txt",
        UploadId: init.UploadId,
        PartNumber: 2,
        Body: "part-2",
      }),
    );

    // Complete with parts in wrong order (2, 1 instead of 1, 2)
    await expect(
      s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "edge-case-bucket",
          Key: "out-of-order.txt",
          UploadId: init.UploadId,
          MultipartUpload: {
            Parts: [
              { PartNumber: 2, ETag: part2.ETag },
              { PartNumber: 1, ETag: part1.ETag },
            ],
          },
        }),
      ),
    ).rejects.toThrow();

    // Clean up
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: "edge-case-bucket",
        Key: "out-of-order.txt",
        UploadId: init.UploadId,
      }),
    );
  });
});
