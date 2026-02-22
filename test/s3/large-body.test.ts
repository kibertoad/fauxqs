import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Large Body", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const bucket = "large-body-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("round-trips a 10 MiB object", async () => {
    const data = Buffer.alloc(10 * 1024 * 1024, 0x42);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "large-10mb", Body: data }));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "large-10mb" }));
    const body = await obj.Body!.transformToByteArray();
    expect(body.length).toBe(10 * 1024 * 1024);
    expect(Buffer.from(body).equals(data)).toBe(true);
  });
});
