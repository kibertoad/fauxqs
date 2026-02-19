import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqs, type FauxqsServer, type S3SpyEvent } from "../../src/app.js";

describe("MessageSpy - S3", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
    s3 = createS3Client(server.port);
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("tracks PutObject as uploaded", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "spy-bucket" }));

    await s3.send(
      new PutObjectCommand({
        Bucket: "spy-bucket",
        Key: "test.txt",
        Body: "hello",
      }),
    );

    const msg = server.spy.checkForMessage({
      service: "s3",
      bucket: "spy-bucket",
      key: "test.txt",
      status: "uploaded",
    });
    expect(msg).toBeDefined();
    expect(msg!.service).toBe("s3");
    expect((msg as S3SpyEvent).bucket).toBe("spy-bucket");
    expect((msg as S3SpyEvent).key).toBe("test.txt");
  });

  it("tracks GetObject as downloaded", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "spy-dl-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "spy-dl-bucket",
        Key: "download.txt",
        Body: "content",
      }),
    );

    await s3.send(
      new GetObjectCommand({
        Bucket: "spy-dl-bucket",
        Key: "download.txt",
      }),
    );

    const msg = server.spy.checkForMessage({
      service: "s3",
      bucket: "spy-dl-bucket",
      key: "download.txt",
      status: "downloaded",
    });
    expect(msg).toBeDefined();
  });

  it("tracks DeleteObject as deleted", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "spy-del-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "spy-del-bucket",
        Key: "delete-me.txt",
        Body: "bye",
      }),
    );

    await s3.send(
      new DeleteObjectCommand({
        Bucket: "spy-del-bucket",
        Key: "delete-me.txt",
      }),
    );

    const msg = server.spy.checkForMessage({
      service: "s3",
      bucket: "spy-del-bucket",
      key: "delete-me.txt",
      status: "deleted",
    });
    expect(msg).toBeDefined();
  });

  it("does not emit deleted for non-existent key", async () => {
    server.spy.clear();
    await s3.send(new CreateBucketCommand({ Bucket: "spy-del-noop" }));

    await s3.send(
      new DeleteObjectCommand({
        Bucket: "spy-del-noop",
        Key: "nope.txt",
      }),
    );

    const msg = server.spy.checkForMessage({
      service: "s3",
      bucket: "spy-del-noop",
      key: "nope.txt",
      status: "deleted",
    });
    expect(msg).toBeUndefined();
  });

  it("CopyObject emits both copied and uploaded", async () => {
    server.spy.clear();
    await s3.send(new CreateBucketCommand({ Bucket: "spy-copy-src" }));
    await s3.send(new CreateBucketCommand({ Bucket: "spy-copy-dst" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "spy-copy-src",
        Key: "original.txt",
        Body: "original content",
      }),
    );

    server.spy.clear();

    await s3.send(
      new CopyObjectCommand({
        Bucket: "spy-copy-dst",
        Key: "copy.txt",
        CopySource: "spy-copy-src/original.txt",
      }),
    );

    const uploaded = server.spy.checkForMessage({
      service: "s3",
      bucket: "spy-copy-dst",
      key: "copy.txt",
      status: "uploaded",
    });
    expect(uploaded).toBeDefined();

    const copied = server.spy.checkForMessage({
      service: "s3",
      bucket: "spy-copy-dst",
      key: "copy.txt",
      status: "copied",
    });
    expect(copied).toBeDefined();
  });

  it("CompleteMultipartUpload emits uploaded", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "spy-multipart" }));

    const create = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: "spy-multipart",
        Key: "big-file.bin",
      }),
    );

    const part = await s3.send(
      new UploadPartCommand({
        Bucket: "spy-multipart",
        Key: "big-file.bin",
        UploadId: create.UploadId!,
        PartNumber: 1,
        Body: Buffer.alloc(1024, "a"),
      }),
    );

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: "spy-multipart",
        Key: "big-file.bin",
        UploadId: create.UploadId!,
        MultipartUpload: {
          Parts: [{ PartNumber: 1, ETag: part.ETag! }],
        },
      }),
    );

    const msg = server.spy.checkForMessage({
      service: "s3",
      bucket: "spy-multipart",
      key: "big-file.bin",
      status: "uploaded",
    });
    expect(msg).toBeDefined();
  });

  it("resolves retroactively for S3 events", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "spy-s3-retro" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "spy-s3-retro",
        Key: "retro.txt",
        Body: "retro",
      }),
    );

    const msg = await server.spy.waitForMessage({
      service: "s3",
      bucket: "spy-s3-retro",
      key: "retro.txt",
      status: "uploaded",
    });
    expect(msg).toBeDefined();
    expect(msg.service).toBe("s3");
  });

  it("resolves in the future for S3 events", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "spy-s3-future" }));

    const promise = server.spy.waitForMessage({
      service: "s3",
      bucket: "spy-s3-future",
      key: "future.txt",
      status: "uploaded",
    });

    await new Promise((r) => setTimeout(r, 50));

    await s3.send(
      new PutObjectCommand({
        Bucket: "spy-s3-future",
        Key: "future.txt",
        Body: "future",
      }),
    );

    const msg = await promise;
    expect(msg.service).toBe("s3");
    expect((msg as S3SpyEvent).key).toBe("future.txt");
  });
});
