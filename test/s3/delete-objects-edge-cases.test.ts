import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 DeleteObjects Edge Cases", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("returns NoSuchBucket when deleting objects from non-existent bucket", async () => {
    try {
      await s3.send(new DeleteObjectsCommand({
        Bucket: "delete-objects-nosuch",
        Delete: { Objects: [{ Key: "a" }] },
      }));
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("NoSuchBucket");
    }
  });

  it("reports non-existent keys as successfully deleted (verbose mode)", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "delete-objects-verbose" }));
    await s3.send(new PutObjectCommand({ Bucket: "delete-objects-verbose", Key: "exists", Body: "data" }));
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: "delete-objects-verbose",
      Delete: {
        Objects: [{ Key: "exists" }, { Key: "does-not-exist" }],
        Quiet: false,
      },
    }));
    const deletedKeys = (result.Deleted ?? []).map(d => d.Key);
    expect(deletedKeys).toContain("exists");
    expect(deletedKeys).toContain("does-not-exist");
    expect(result.Errors ?? []).toHaveLength(0);
  });
});
