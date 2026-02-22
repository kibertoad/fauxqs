import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 System Metadata", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const bucket = "sysmeta-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("stores and returns Content-Language on Put/Get", async () => {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: "lang-test", Body: "bonjour",
      ContentLanguage: "fr",
    }));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "lang-test" }));
    expect(obj.ContentLanguage).toBe("fr");
  });

  it("stores and returns Content-Disposition on Put/Head", async () => {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: "disp-test", Body: "file",
      ContentDisposition: "attachment; filename=\"test.txt\"",
    }));
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "disp-test" }));
    expect(head.ContentDisposition).toBe("attachment; filename=\"test.txt\"");
  });

  it("stores and returns Cache-Control", async () => {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: "cache-test", Body: "cached",
      CacheControl: "max-age=3600",
    }));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "cache-test" }));
    expect(obj.CacheControl).toBe("max-age=3600");
  });

  it("CopyObject with COPY directive preserves system metadata", async () => {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: "copy-src-meta", Body: "data",
      ContentLanguage: "de", ContentDisposition: "inline",
      CacheControl: "no-cache",
    }));
    await s3.send(new CopyObjectCommand({
      Bucket: bucket, Key: "copy-dst-meta",
      CopySource: `${bucket}/copy-src-meta`,
    }));
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "copy-dst-meta" }));
    expect(head.ContentLanguage).toBe("de");
    expect(head.ContentDisposition).toBe("inline");
    expect(head.CacheControl).toBe("no-cache");
  });

  it("CopyObject with REPLACE directive uses request metadata", async () => {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: "replace-src", Body: "data",
      ContentLanguage: "en",
    }));
    await s3.send(new CopyObjectCommand({
      Bucket: bucket, Key: "replace-dst",
      CopySource: `${bucket}/replace-src`,
      MetadataDirective: "REPLACE",
      ContentLanguage: "ja",
    }));
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: "replace-dst" }));
    expect(head.ContentLanguage).toBe("ja");
  });
});
