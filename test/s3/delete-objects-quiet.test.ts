import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 DeleteObjects Quiet Mode", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "quiet-bucket" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("returns Deleted entries in normal (non-quiet) mode", async () => {
    await s3.send(
      new PutObjectCommand({ Bucket: "quiet-bucket", Key: "normal-1.txt", Body: "a" }),
    );
    await s3.send(
      new PutObjectCommand({ Bucket: "quiet-bucket", Key: "normal-2.txt", Body: "b" }),
    );

    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: "quiet-bucket",
        Delete: {
          Objects: [{ Key: "normal-1.txt" }, { Key: "normal-2.txt" }],
          Quiet: false,
        },
      }),
    );

    expect(result.Deleted).toHaveLength(2);
    expect(result.Deleted!.map((d) => d.Key).sort()).toEqual(["normal-1.txt", "normal-2.txt"]);
  });

  it("returns no Deleted entries in quiet mode", async () => {
    await s3.send(
      new PutObjectCommand({ Bucket: "quiet-bucket", Key: "quiet-1.txt", Body: "a" }),
    );
    await s3.send(
      new PutObjectCommand({ Bucket: "quiet-bucket", Key: "quiet-2.txt", Body: "b" }),
    );

    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: "quiet-bucket",
        Delete: {
          Objects: [{ Key: "quiet-1.txt" }, { Key: "quiet-2.txt" }],
          Quiet: true,
        },
      }),
    );

    // In quiet mode, no Deleted entries are returned (only errors, if any)
    expect(result.Deleted ?? []).toHaveLength(0);
  });
});
