import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  PutObjectCommand,
  UploadPartCommand,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqs, type FauxqsServer } from "../../src/app.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = Date.UTC(2026, 0, 1);

describe("S3 object expiry", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;

  async function start(options?: { objectRetention?: { maxSeconds?: number } }): Promise<void> {
    server = await startFauxqs({ port: 0, logger: false, ...options });
    s3 = createS3Client(server.port);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
  });

  afterEach(async () => {
    s3.destroy();
    await server.stop();
    vi.useRealTimers();
  });

  /** Move the clock and make the request that starts the expiry sweep. */
  async function sweepAt(time: number): Promise<void> {
    vi.setSystemTime(time);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
  }

  async function createBucket(bucket: string, rules?: LifecycleRule[]): Promise<void> {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    if (rules) {
      await s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: { Rules: rules },
        }),
      );
    }
  }

  async function put(bucket: string, key: string, body = "data"): Promise<void> {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  }

  async function keys(bucket: string): Promise<string[]> {
    const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    return (Contents ?? []).map((object) => object.Key!);
  }

  async function expectKeys(bucket: string, expected: string[]): Promise<void> {
    await vi.waitFor(async () => {
      expect(await keys(bucket)).toEqual(expected);
    });
  }

  async function uploadIsOpen(bucket: string, key: string, uploadId: string): Promise<boolean> {
    try {
      await s3.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: 1,
          Body: "part",
        }),
      );
      return true;
    } catch (err) {
      expect((err as Error).name).toBe("NoSuchUpload");
      return false;
    }
  }

  it("expires an object at the first midnight UTC after its Expiration Days have passed", async () => {
    await start();
    await createBucket("expiry-days", [
      { ID: "logs", Status: "Enabled", Filter: { Prefix: "logs/" }, Expiration: { Days: 1 } },
    ]);
    vi.setSystemTime(t0 + HOUR);
    await put("expiry-days", "logs/a");
    await put("expiry-days", "keep/b");

    // One day after the upload is 01:00 on January 2. The object lasts until midnight.
    await sweepAt(t0 + 2 * DAY - HOUR);
    expect(await keys("expiry-days")).toEqual(["keep/b", "logs/a"]);

    await sweepAt(t0 + 2 * DAY);
    await expectKeys("expiry-days", ["keep/b"]);
  });

  it("expires objects once the clock reaches an Expiration Date", async () => {
    await start();
    await createBucket("expiry-date", [
      {
        ID: "by-date",
        Status: "Enabled",
        Filter: {},
        Expiration: { Date: new Date(t0 + DAY) },
      },
    ]);
    await put("expiry-date", "a");

    await sweepAt(t0 + DAY - HOUR);
    expect(await keys("expiry-date")).toEqual(["a"]);

    await sweepAt(t0 + DAY);
    await expectKeys("expiry-date", []);
  });

  it("ignores a disabled rule", async () => {
    await start();
    await createBucket("expiry-disabled", [
      { ID: "off", Status: "Disabled", Filter: {}, Expiration: { Days: 1 } },
    ]);
    await put("expiry-disabled", "a");

    await sweepAt(t0 + 10 * DAY);
    await sweepAt(t0 + 11 * DAY);

    expect(await keys("expiry-disabled")).toEqual(["a"]);
  });

  it("applies the object size bounds of a rule", async () => {
    await start();
    await createBucket("expiry-size", [
      {
        ID: "mid-sized",
        Status: "Enabled",
        Filter: { And: { Prefix: "", ObjectSizeGreaterThan: 3, ObjectSizeLessThan: 10 } },
        Expiration: { Days: 1 },
      },
    ]);
    await put("expiry-size", "small", "123");
    await put("expiry-size", "mid", "12345");
    await put("expiry-size", "large", "1234567890");

    await sweepAt(t0 + 2 * DAY);

    await expectKeys("expiry-size", ["large", "small"]);
  });

  it("does not apply a rule filtered by tag", async () => {
    await start();
    await createBucket("expiry-tag", [
      {
        ID: "tagged",
        Status: "Enabled",
        Filter: { Tag: { Key: "temp", Value: "true" } },
        Expiration: { Days: 1 },
      },
    ]);
    await put("expiry-tag", "a");

    await sweepAt(t0 + 10 * DAY);
    await sweepAt(t0 + 11 * DAY);

    expect(await keys("expiry-tag")).toEqual(["a"]);
  });

  it("aborts an incomplete multipart upload after DaysAfterInitiation", async () => {
    await start();
    await createBucket("expiry-abort", [
      {
        ID: "abort",
        Status: "Enabled",
        Filter: { Prefix: "tmp/" },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
      },
    ]);
    const matching = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: "expiry-abort", Key: "tmp/a" }),
    );
    const other = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: "expiry-abort", Key: "keep/b" }),
    );

    await sweepAt(t0 + 2 * DAY - HOUR);
    expect(await uploadIsOpen("expiry-abort", "tmp/a", matching.UploadId!)).toBe(true);

    await sweepAt(t0 + 2 * DAY);
    await vi.waitFor(async () => {
      expect(await uploadIsOpen("expiry-abort", "tmp/a", matching.UploadId!)).toBe(false);
    });
    expect(await uploadIsOpen("expiry-abort", "keep/b", other.UploadId!)).toBe(true);
  });

  it("sends an s3:LifecycleExpiration:Delete event for an object a rule expired", async () => {
    await start();
    const { queueArn } = server.createQueue("expiry-events");
    await createBucket("expiry-notify", [
      { ID: "all", Status: "Enabled", Filter: {}, Expiration: { Days: 1 } },
    ]);
    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: "expiry-notify",
        NotificationConfiguration: {
          QueueConfigurations: [{ QueueArn: queueArn, Events: ["s3:LifecycleExpiration:Delete"] }],
        },
      }),
    );
    await put("expiry-notify", "a");

    await sweepAt(t0 + 2 * DAY);

    await vi.waitFor(() => {
      const { ready } = server.inspectQueue("expiry-events")!.messages;
      const records = ready.flatMap((message) => JSON.parse(message.body).Records ?? []);
      expect(records.map((record) => [record.eventName, record.s3.object.key])).toEqual([
        ["LifecycleExpiration:Delete", "a"],
      ]);
    });
  });

  it("deletes objects older than objectRetention.maxSeconds in a bucket with no lifecycle rules", async () => {
    await start({ objectRetention: { maxSeconds: 120 } });
    await createBucket("expiry-cap");
    await put("expiry-cap", "old");
    vi.setSystemTime(t0 + 90_000);
    await put("expiry-cap", "fresh");

    await sweepAt(t0 + 120_000);
    expect(await keys("expiry-cap")).toEqual(["fresh", "old"]);

    await sweepAt(t0 + 180_001);
    await expectKeys("expiry-cap", ["fresh"]);
  });

  it("aborts incomplete multipart uploads older than objectRetention.maxSeconds", async () => {
    await start({ objectRetention: { maxSeconds: 120 } });
    await createBucket("expiry-cap-uploads");
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: "expiry-cap-uploads", Key: "a" }),
    );

    await sweepAt(t0 + 120_001);

    await vi.waitFor(async () => {
      expect(await uploadIsOpen("expiry-cap-uploads", "a", UploadId!)).toBe(false);
    });
  });

  it("expires by a lifecycle rule before objectRetention.maxSeconds when the rule is shorter", async () => {
    await start({ objectRetention: { maxSeconds: 30 * 24 * 3600 } });
    await createBucket("expiry-both", [
      { ID: "all", Status: "Enabled", Filter: {}, Expiration: { Days: 1 } },
    ]);
    await put("expiry-both", "a");

    await sweepAt(t0 + DAY);

    await expectKeys("expiry-both", []);
  });
});
