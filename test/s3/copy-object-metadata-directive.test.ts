import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 CopyObject MetadataDirective", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "meta-dir-bucket" }));

    await s3.send(
      new PutObjectCommand({
        Bucket: "meta-dir-bucket",
        Key: "source.txt",
        Body: "source content",
        Metadata: { author: "alice", version: "1" },
      }),
    );
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("COPY directive preserves source metadata even when request includes metadata", async () => {
    await s3.send(
      new CopyObjectCommand({
        Bucket: "meta-dir-bucket",
        Key: "copy-default.txt",
        CopySource: "meta-dir-bucket/source.txt",
        MetadataDirective: "COPY",
        Metadata: { should: "be-ignored" },
      }),
    );

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: "meta-dir-bucket", Key: "copy-default.txt" }),
    );
    expect(head.Metadata?.author).toBe("alice");
    expect(head.Metadata?.version).toBe("1");
    expect(head.Metadata?.should).toBeUndefined();
  });

  it("REPLACE directive uses request metadata and ignores source metadata", async () => {
    await s3.send(
      new CopyObjectCommand({
        Bucket: "meta-dir-bucket",
        Key: "copy-replaced.txt",
        CopySource: "meta-dir-bucket/source.txt",
        MetadataDirective: "REPLACE",
        Metadata: { newkey: "newval" },
      }),
    );

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: "meta-dir-bucket", Key: "copy-replaced.txt" }),
    );
    expect(head.Metadata?.newkey).toBe("newval");
    expect(head.Metadata?.author).toBeUndefined();
    expect(head.Metadata?.version).toBeUndefined();
  });

  it("REPLACE directive with no metadata clears all metadata", async () => {
    await s3.send(
      new CopyObjectCommand({
        Bucket: "meta-dir-bucket",
        Key: "copy-cleared.txt",
        CopySource: "meta-dir-bucket/source.txt",
        MetadataDirective: "REPLACE",
      }),
    );

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: "meta-dir-bucket", Key: "copy-cleared.txt" }),
    );
    expect(head.Metadata?.author).toBeUndefined();
    expect(head.Metadata?.version).toBeUndefined();
  });

  it("defaults to COPY when MetadataDirective is not specified", async () => {
    await s3.send(
      new CopyObjectCommand({
        Bucket: "meta-dir-bucket",
        Key: "copy-default-implicit.txt",
        CopySource: "meta-dir-bucket/source.txt",
      }),
    );

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: "meta-dir-bucket", Key: "copy-default-implicit.txt" }),
    );
    expect(head.Metadata?.author).toBe("alice");
    expect(head.Metadata?.version).toBe("1");
  });
});
