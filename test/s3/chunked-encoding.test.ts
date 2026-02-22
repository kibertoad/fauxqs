import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Chunked Encoding", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const bucket = "chunked-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("handles regular SDK put/get round-trip (SDK may use chunked encoding internally)", async () => {
    const data = "x".repeat(100_000);
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: "chunked-key", Body: data,
    }));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "chunked-key" }));
    const body = await obj.Body!.transformToString();
    expect(body).toBe(data);
    expect(body.length).toBe(100_000);
  });
});
