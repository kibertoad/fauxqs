import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Special Character Keys", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const bucket = "special-chars-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("handles key with plus sign", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "path+plus", Body: "data" }));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "path+plus" }));
    expect(await obj.Body!.transformToString()).toBe("data");
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "path+plus" }));
  });

  it("handles key with hash sign", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "path#hash", Body: "data" }));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "path#hash" }));
    expect(await obj.Body!.transformToString()).toBe("data");
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "path#hash" }));
  });

  it("handles key with unicode characters", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "\u65E5\u672C\u8A9E/\u30C6\u30B9\u30C8", Body: "unicode" }));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "\u65E5\u672C\u8A9E/\u30C6\u30B9\u30C8" }));
    expect(await obj.Body!.transformToString()).toBe("unicode");
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "\u65E5\u672C\u8A9E/\u30C6\u30B9\u30C8" }));
  });

  it("handles key with spaces", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "path with spaces/file name.txt", Body: "spaces" }));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "path with spaces/file name.txt" }));
    expect(await obj.Body!.transformToString()).toBe("spaces");
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "path with spaces/file name.txt" }));
  });

  it("handles key with trailing slash (folder-like)", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "folder/", Body: "" }));
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "folder/" }));
    expect(head.ContentLength).toBe(0);
    // List should show the key
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "folder/" }));
    expect(list.Contents?.some(o => o.Key === "folder/")).toBe(true);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "folder/" }));
  });

  it("lists keys with special characters correctly", async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "a+b", Body: "1" }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "c#d", Body: "2" }));
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    const keys = (list.Contents ?? []).map(o => o.Key);
    expect(keys).toContain("a+b");
    expect(keys).toContain("c#d");
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "a+b" }));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "c#d" }));
  });
});
