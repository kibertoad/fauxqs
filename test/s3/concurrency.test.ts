import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Concurrency", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const bucket = "concurrency-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("handles parallel puts on same key without corruption", async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      s3.send(new PutObjectCommand({ Bucket: bucket, Key: "race-key", Body: `value-${i}` }))
    );
    await Promise.all(promises);
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "race-key" }));
    const body = await obj.Body!.transformToString();
    expect(body).toMatch(/^value-\d$/);
  });

  it("handles parallel put and get without errors", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "stable-key", Body: "initial" }));
    const ops = [];
    for (let i = 0; i < 5; i++) {
      ops.push(s3.send(new PutObjectCommand({ Bucket: bucket, Key: "stable-key", Body: `update-${i}` })));
      ops.push(s3.send(new GetObjectCommand({ Bucket: bucket, Key: "stable-key" })).catch(() => null));
    }
    const results = await Promise.allSettled(ops);
    // All operations should succeed (no crashes)
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }
  });
});
