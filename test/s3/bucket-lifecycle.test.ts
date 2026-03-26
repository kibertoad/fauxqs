import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Bucket Lifecycle Configuration", () => {
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

  it("puts and gets lifecycle configuration", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "lifecycle-bucket" }));

    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: "lifecycle-bucket",
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "DeleteOldObjects",
              Status: "Enabled",
              Filter: {},
              Expiration: { Days: 1 },
            },
          ],
        },
      }),
    );

    const result = await s3.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: "lifecycle-bucket" }),
    );
    expect(result.Rules).toHaveLength(1);
    expect(result.Rules![0].ID).toBe("DeleteOldObjects");
    expect(result.Rules![0].Status).toBe("Enabled");
    expect(result.Rules![0].Expiration?.Days).toBe(1);
  });

  it("returns error when no lifecycle configuration exists", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "no-lifecycle-bucket" }));

    await expect(
      s3.send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: "no-lifecycle-bucket",
        }),
      ),
    ).rejects.toMatchObject({ name: "NoSuchLifecycleConfiguration" });
  });

  it("deletes lifecycle configuration", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "delete-lifecycle-bucket" }));

    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: "delete-lifecycle-bucket",
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "Rule1",
              Status: "Enabled",
              Filter: {},
              Expiration: { Days: 7 },
            },
          ],
        },
      }),
    );

    const deleteResult = await s3.send(
      new DeleteBucketLifecycleCommand({
        Bucket: "delete-lifecycle-bucket",
      }),
    );
    expect(deleteResult.$metadata.httpStatusCode).toBe(204);

    await expect(
      s3.send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: "delete-lifecycle-bucket",
        }),
      ),
    ).rejects.toMatchObject({ name: "NoSuchLifecycleConfiguration" });
  });

  it("lifecycle configuration is removed when bucket is deleted", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "bucket-with-lifecycle" }));

    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: "bucket-with-lifecycle",
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "Cleanup",
              Status: "Enabled",
              Filter: {},
              Expiration: { Days: 30 },
            },
          ],
        },
      }),
    );

    await s3.send(new DeleteBucketCommand({ Bucket: "bucket-with-lifecycle" }));

    // Re-create bucket — should not have old lifecycle config
    await s3.send(new CreateBucketCommand({ Bucket: "bucket-with-lifecycle" }));

    await expect(
      s3.send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: "bucket-with-lifecycle",
        }),
      ),
    ).rejects.toMatchObject({ name: "NoSuchLifecycleConfiguration" });
  });

  it("replaces existing lifecycle configuration", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "replace-lifecycle-bucket" }));

    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: "replace-lifecycle-bucket",
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "OldRule",
              Status: "Enabled",
              Filter: {},
              Expiration: { Days: 1 },
            },
          ],
        },
      }),
    );

    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: "replace-lifecycle-bucket",
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "NewRule",
              Status: "Disabled",
              Filter: { Prefix: "logs/" },
              Expiration: { Days: 90 },
            },
          ],
        },
      }),
    );

    const result = await s3.send(
      new GetBucketLifecycleConfigurationCommand({
        Bucket: "replace-lifecycle-bucket",
      }),
    );
    expect(result.Rules).toHaveLength(1);
    expect(result.Rules![0].ID).toBe("NewRule");
    expect(result.Rules![0].Status).toBe("Disabled");
    expect(result.Rules![0].Expiration?.Days).toBe(90);
  });
});
