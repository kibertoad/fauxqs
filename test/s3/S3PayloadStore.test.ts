import { Readable } from "node:stream";

import { S3, NotFound } from "@aws-sdk/client-s3";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolvePayloadStoreConfig, S3PayloadStore } from "@message-queue-toolkit/s3-payload-store";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

const TEST_BUCKET = "test-bucket";

async function assertEmptyBucket(s3: S3, bucketName: string) {
  try {
    await s3.headBucket({ Bucket: bucketName });
    const objects = await s3.listObjects({ Bucket: bucketName });
    if (objects.Contents?.length) {
      await s3.deleteObjects({
        Bucket: bucketName,
        Delete: {
          Objects: objects.Contents?.map((object) => ({ Key: object.Key })),
        },
      });
    }
  } catch (e) {
    if (e instanceof NotFound) {
      await s3.createBucket({ Bucket: bucketName });
      return;
    }
    throw e;
  }
}

async function getObjectContent(s3: S3, bucket: string, key: string) {
  const result = await s3.getObject({ Bucket: bucket, Key: key });
  return result.Body?.transformToString();
}

async function objectExists(s3: S3, bucket: string, key: string) {
  try {
    await s3.headObject({ Bucket: bucket, Key: key });
    return true;
  } catch {
    return false;
  }
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") {
      continue;
    }
    chunks.push(!Buffer.isBuffer(chunk) ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("S3PayloadStore", () => {
  let server: FauxqsServer;
  let s3: S3;
  let store: S3PayloadStore;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = new S3({
      endpoint: `http://127.0.0.1:${server.port}`,
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      forcePathStyle: true,
    });
    store = new S3PayloadStore({ s3 }, { bucketName: TEST_BUCKET });
  });

  beforeEach(async () => {
    await assertEmptyBucket(s3, TEST_BUCKET);
  });

  describe("storePayload", () => {
    it("stores the payload in the bucket", async () => {
      const payload = "test";

      const stringPayloadKey = await store.storePayload({
        value: payload,
        size: payload.length,
      });

      const streamPayloadKey = await store.storePayload({
        value: Readable.from(payload),
        size: payload.length,
      });
      expect(await getObjectContent(s3, TEST_BUCKET, stringPayloadKey)).toBe(payload);
      expect(await getObjectContent(s3, TEST_BUCKET, streamPayloadKey)).toBe(payload);
    });

    it("uses key prefix if provided", async () => {
      const prefixStore = new S3PayloadStore(
        { s3 },
        { bucketName: TEST_BUCKET, keyPrefix: "prefix" },
      );
      const payload = "test";
      const stringPayloadKey = await prefixStore.storePayload({
        value: payload,
        size: payload.length,
      });

      expect(stringPayloadKey).toContain("prefix/");
    });
  });

  describe("retrievePayload", () => {
    it("retrieves previously stored payload", async () => {
      const payload = "test";
      const key = await store.storePayload({
        value: Readable.from(payload),
        size: payload.length,
      });

      const result = await store.retrievePayload(key);

      expect(result).toBeInstanceOf(Readable);
      await expect(streamToString(result!)).resolves.toBe(payload);
    });

    it("returns null if payload cannot be found", async () => {
      const result = await store.retrievePayload("non-existing-key");
      expect(result).toBe(null);
    });

    it("throws, if other than not-found error occurs", async () => {
      const badStore = new S3PayloadStore({ s3 }, { bucketName: "non-existing-bucket" });
      await expect(badStore.retrievePayload("non-existing-key")).rejects.toThrow();
    });
  });

  describe("deletePayload", () => {
    it("successfully deletes previously stored payload", async () => {
      const payload = "test";
      const key = await store.storePayload({
        value: Readable.from(payload),
        size: payload.length,
      });
      await expect(objectExists(s3, TEST_BUCKET, key)).resolves.toBeTruthy();

      await store.deletePayload(key);

      await expect(objectExists(s3, TEST_BUCKET, key)).resolves.toBeFalsy();
    });

    it("gracefully handles non-existing key", async () => {
      await expect(store.deletePayload("non-existing-key")).resolves.not.toThrow();
    });
  });

  describe("resolvePayloadStoreConfig", () => {
    it("should return undefined if s3PayloadOffloadingBucket is not set", () => {
      const result = resolvePayloadStoreConfig({ s3: {} as any });
      expect(result).toBeUndefined();
    });

    it("should throw an error if S3 is not defined", () => {
      expect(() =>
        resolvePayloadStoreConfig(
          { s3: undefined },
          {
            s3PayloadOffloadingBucket: "test-bucket",
            messageSizeThreshold: 1,
          },
        ),
      ).toThrowError("AWS S3 client is required for payload offloading");
    });

    it("should payload store config", () => {
      const result = resolvePayloadStoreConfig(
        { s3: {} as any },
        { s3PayloadOffloadingBucket: "test-bucket", messageSizeThreshold: 1 },
      );
      expect(result).toEqual({
        store: expect.any(S3PayloadStore),
        storeName: "s3",
        messageSizeThreshold: 1,
      });
    });
  });
});
