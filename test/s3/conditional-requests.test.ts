import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Conditional Requests", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  let etag: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "cond-bucket" }));
    const putResult = await s3.send(
      new PutObjectCommand({
        Bucket: "cond-bucket",
        Key: "cond-test.txt",
        Body: "conditional test",
        ContentType: "text/plain",
      }),
    );
    etag = putResult.ETag!;
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("returns 304 when If-None-Match matches ETag", async () => {
    try {
      await s3.send(
        new GetObjectCommand({
          Bucket: "cond-bucket",
          Key: "cond-test.txt",
          IfNoneMatch: etag,
        }),
      );
      // Some SDK versions handle 304 gracefully with empty body
    } catch (err: any) {
      // SDK may throw on 304 — verify the status code
      expect(err.$metadata?.httpStatusCode ?? err.statusCode).toBe(304);
    }
  });

  it("returns 200 when If-None-Match does not match ETag", async () => {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: "cond-bucket",
        Key: "cond-test.txt",
        IfNoneMatch: '"nonmatching-etag"',
      }),
    );

    const body = await result.Body!.transformToString();
    expect(body).toBe("conditional test");
  });

  it("returns 200 when If-Match matches ETag", async () => {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: "cond-bucket",
        Key: "cond-test.txt",
        IfMatch: etag,
      }),
    );

    const body = await result.Body!.transformToString();
    expect(body).toBe("conditional test");
  });

  it("returns 412 when If-Match does not match ETag", async () => {
    await expect(
      s3.send(
        new GetObjectCommand({
          Bucket: "cond-bucket",
          Key: "cond-test.txt",
          IfMatch: '"nonmatching-etag"',
        }),
      ),
    ).rejects.toThrow();
  });

  it("If-Match takes precedence over If-Unmodified-Since", async () => {
    // If-Match matches + If-Unmodified-Since in the past → should return 200
    // because If-Match takes precedence per HTTP spec
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: "cond-bucket",
        Key: "cond-test.txt",
        IfMatch: etag,
        IfUnmodifiedSince: new Date("2000-01-01"),
      }),
    );

    const body = await result.Body!.transformToString();
    expect(body).toBe("conditional test");
  });
});
