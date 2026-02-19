import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 XML Body Parsing (3.10)", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "xml-test" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("correctly deletes objects with special XML characters in keys", async () => {
    // Put objects with keys containing characters that need XML escaping
    const specialKeys = [
      "file&name.txt",
      "path/with<angle>brackets.txt",
      "quotes\"and'apostrophes.txt",
    ];

    for (const key of specialKeys) {
      await s3.send(
        new PutObjectCommand({
          Bucket: "xml-test",
          Key: key,
          Body: `content-${key}`,
        }),
      );
    }

    // Bulk delete all of them
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: "xml-test",
        Delete: {
          Objects: specialKeys.map((key) => ({ Key: key })),
        },
      }),
    );

    expect(result.Deleted).toHaveLength(3);

    // Verify they're actually deleted
    for (const key of specialKeys) {
      await expect(
        s3.send(new GetObjectCommand({ Bucket: "xml-test", Key: key })),
      ).rejects.toThrow();
    }
  });

});
