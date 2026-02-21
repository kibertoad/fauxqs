import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Range Requests", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "range-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "range-bucket",
        Key: "range-test.txt",
        Body: "Hello, World!",
        ContentType: "text/plain",
      }),
    );
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("returns first 5 bytes with Range: bytes=0-4", async () => {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: "range-bucket",
        Key: "range-test.txt",
        Range: "bytes=0-4",
      }),
    );

    expect(result.ContentRange).toBe("bytes 0-4/13");
    const body = await result.Body!.transformToString();
    expect(body).toBe("Hello");
  });

  it("returns from byte 7 to end with Range: bytes=7-", async () => {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: "range-bucket",
        Key: "range-test.txt",
        Range: "bytes=7-",
      }),
    );

    expect(result.ContentRange).toBe("bytes 7-12/13");
    const body = await result.Body!.transformToString();
    expect(body).toBe("World!");
  });

  it("returns last 6 bytes with Range: bytes=-6", async () => {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: "range-bucket",
        Key: "range-test.txt",
        Range: "bytes=-6",
      }),
    );

    expect(result.ContentRange).toBe("bytes 7-12/13");
    const body = await result.Body!.transformToString();
    expect(body).toBe("World!");
  });

  it("returns full body without Range header", async () => {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: "range-bucket",
        Key: "range-test.txt",
      }),
    );

    expect(result.ContentRange).toBeUndefined();
    const body = await result.Body!.transformToString();
    expect(body).toBe("Hello, World!");
  });

  it("returns 416 for unsatisfiable range", async () => {
    await expect(
      s3.send(
        new GetObjectCommand({
          Bucket: "range-bucket",
          Key: "range-test.txt",
          Range: "bytes=100-200",
        }),
      ),
    ).rejects.toThrow();
  });
});
