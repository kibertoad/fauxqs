import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqs, type FauxqsServer } from "../../src/app.js";
import { PersistenceManager } from "../../src/persistence.js";
import { SqsStore } from "../../src/sqs/sqsStore.js";
import { SnsStore } from "../../src/sns/snsStore.js";
import { S3Store } from "../../src/s3/s3Store.js";

const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.UTC(2026, 0, 1);
const PART_SIZE = 5 * 1024 * 1024;

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "fauxqs-test-"));
}

function queryDb<T>(dataDir: string, sql: string): T {
  const db = new DatabaseSync(join(dataDir, "fauxqs.db"));
  const row = db.prepare(sql).get() as T;
  db.close();
  return row;
}

function countRows(dataDir: string, table: string): number {
  return queryDb<{ count: number }>(dataDir, `SELECT COUNT(*) AS count FROM ${table}`).count;
}

// Servers and clients a test opened and has not closed yet. A failed assertion skips the test's
// own stop() and destroy() calls, so each afterEach closes what is left before it removes the
// directories they use.
const openServers = new Set<FauxqsServer>();
const openClients = new Set<S3Client>();

async function startServer(options: Parameters<typeof startFauxqs>[0]): Promise<FauxqsServer> {
  const server = await startFauxqs(options);
  openServers.add(server);
  const stop = server.stop.bind(server);
  server.stop = () => {
    openServers.delete(server);
    return stop();
  };
  return server;
}

function s3Client(port: number): S3Client {
  const client = createS3Client(port);
  openClients.add(client);
  const destroy = client.destroy.bind(client);
  client.destroy = () => {
    openClients.delete(client);
    destroy();
  };
  return client;
}

async function closeOpen(): Promise<void> {
  for (const client of openClients) client.destroy();
  for (const server of openServers) await server.stop();
}

describe.each([
  { backend: "SQLite", useFiles: false },
  { backend: "file", useFiles: true },
])("Persistence: multipart uploads with $backend S3 storage", ({ useFiles }) => {
  let dataDir: string;
  let s3StorageDir: string;

  function start(): Promise<FauxqsServer> {
    return startServer({
      port: 0,
      logger: false,
      dataDir,
      ...(useFiles && { s3StorageDir }),
    });
  }

  beforeEach(() => {
    dataDir = createTempDir();
    s3StorageDir = createTempDir();
  });

  afterEach(async () => {
    await closeOpen();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(s3StorageDir, { recursive: true, force: true });
  });

  it("completes an upload from parts sent before and after a restart", async () => {
    const part1 = Buffer.alloc(PART_SIZE, "a");
    const part2 = Buffer.from("tail");

    let server = await start();
    let s3 = s3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "multipart-restart" }));
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: "multipart-restart", Key: "big" }),
    );
    const uploaded1 = await s3.send(
      new UploadPartCommand({
        Bucket: "multipart-restart",
        Key: "big",
        UploadId,
        PartNumber: 1,
        Body: part1,
      }),
    );
    s3.destroy();
    await server.stop();

    server = await start();
    s3 = s3Client(server.port);
    const uploaded2 = await s3.send(
      new UploadPartCommand({
        Bucket: "multipart-restart",
        Key: "big",
        UploadId,
        PartNumber: 2,
        Body: part2,
      }),
    );
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: "multipart-restart",
        Key: "big",
        UploadId,
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: uploaded1.ETag },
            { PartNumber: 2, ETag: uploaded2.ETag },
          ],
        },
      }),
    );

    const object = await s3.send(new GetObjectCommand({ Bucket: "multipart-restart", Key: "big" }));
    const body = Buffer.from(await object.Body!.transformToByteArray());
    expect(body.equals(Buffer.concat([part1, part2]))).toBe(true);
    s3.destroy();
    await server.stop();
  });

  it("rejects a non-final part under 5 MiB that was stored before a restart", async () => {
    let server = await start();
    let s3 = s3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "multipart-small" }));
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: "multipart-small", Key: "k" }),
    );
    const parts = [];
    for (const PartNumber of [1, 2]) {
      const { ETag } = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-small",
          Key: "k",
          UploadId,
          PartNumber,
          Body: "small",
        }),
      );
      parts.push({ PartNumber, ETag });
    }
    s3.destroy();
    await server.stop();

    server = await start();
    s3 = s3Client(server.port);
    await expect(
      s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: "multipart-small",
          Key: "k",
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      ),
    ).rejects.toMatchObject({ name: "EntityTooSmall" });
    s3.destroy();
    await server.stop();
  });

  it.runIf(useFiles)(
    "refuses to complete with a stored part body that does not match its ETag",
    async () => {
      const server = await start();
      const s3 = s3Client(server.port);
      await s3.send(new CreateBucketCommand({ Bucket: "multipart-mismatch" }));
      const { UploadId } = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: "multipart-mismatch", Key: "k" }),
      );
      const { ETag } = await s3.send(
        new UploadPartCommand({
          Bucket: "multipart-mismatch",
          Key: "k",
          UploadId,
          PartNumber: 1,
          Body: "original",
        }),
      );
      // What a replacement leaves behind when its data was written and its metadata was not.
      writeFileSync(join(s3StorageDir, "_multipart", UploadId!, "parts", "1.data"), "replaced");

      await expect(
        s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: "multipart-mismatch",
            Key: "k",
            UploadId,
            MultipartUpload: { Parts: [{ PartNumber: 1, ETag }] },
          }),
        ),
      ).rejects.toMatchObject({ name: "InternalError" });
      s3.destroy();
      await server.stop();
    },
  );
});

describe("Persistence: S3 object expiry", () => {
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    dataDir = createTempDir();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeOpen();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function storeObjectAndUpload(bucket: string): Promise<void> {
    const server = await startServer({ port: 0, logger: false, dataDir });
    const s3 = s3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "old", Body: "data" }));
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: "upload" }),
    );
    await s3.send(
      new UploadPartCommand({ Bucket: bucket, Key: "upload", UploadId, PartNumber: 1, Body: "p" }),
    );
    s3.destroy();
    await server.stop();
  }

  async function listKeys(server: FauxqsServer, bucket: string): Promise<string[]> {
    const s3 = s3Client(server.port);
    const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    s3.destroy();
    return (Contents ?? []).map((object) => object.Key!);
  }

  it("deletes stored objects and uploads older than objectRetention.maxSeconds at startup", async () => {
    await storeObjectAndUpload("cap-restart");

    vi.setSystemTime(t0 + 60_001);
    const server = await startServer({
      port: 0,
      logger: false,
      dataDir,
      objectRetention: { maxSeconds: 60 },
    });

    expect(await listKeys(server, "cap-restart")).toEqual([]);
    await server.stop();
    expect(countRows(dataDir, "s3_objects")).toBe(0);
    expect(countRows(dataDir, "s3_multipart_uploads")).toBe(0);
    expect(countRows(dataDir, "s3_multipart_parts")).toBe(0);
  });

  it("keeps stored objects and uploads whose age equals objectRetention.maxSeconds", async () => {
    await storeObjectAndUpload("cap-boundary");

    vi.setSystemTime(t0 + 60_000);
    const server = await startServer({
      port: 0,
      logger: false,
      dataDir,
      objectRetention: { maxSeconds: 60 },
    });

    expect(await listKeys(server, "cap-boundary")).toEqual(["old"]);
    await server.stop();
    expect(countRows(dataDir, "s3_multipart_parts")).toBe(1);
  });

  it("deletes the stored row of an object that a lifecycle rule expired while the server was stopped", async () => {
    let server = await startServer({ port: 0, logger: false, dataDir });
    const s3 = s3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "rule-restart" }));
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: "rule-restart",
        LifecycleConfiguration: {
          Rules: [{ ID: "all", Status: "Enabled", Filter: {}, Expiration: { Days: 1 } }],
        },
      }),
    );
    await s3.send(new PutObjectCommand({ Bucket: "rule-restart", Key: "a", Body: "data" }));
    s3.destroy();
    await server.stop();

    vi.setSystemTime(t0 + DAY);
    server = await startServer({ port: 0, logger: false, dataDir });

    expect(await listKeys(server, "rule-restart")).toEqual([]);
    await server.stop();
    expect(countRows(dataDir, "s3_objects")).toBe(0);
  });

  it("uses the lifecycle rules from the init config for the startup sweep", async () => {
    let server = await startServer({ port: 0, logger: false, dataDir });
    const s3 = s3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "init-rules" }));
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: "init-rules",
        LifecycleConfiguration: {
          Rules: [{ ID: "all", Status: "Enabled", Filter: {}, Expiration: { Days: 1 } }],
        },
      }),
    );
    await s3.send(new PutObjectCommand({ Bucket: "init-rules", Key: "a", Body: "data" }));
    s3.destroy();
    await server.stop();

    vi.setSystemTime(t0 + 2 * DAY);
    server = await startServer({
      port: 0,
      logger: false,
      dataDir,
      init: {
        buckets: [
          {
            name: "init-rules",
            lifecycleConfiguration: {
              Rules: [{ ID: "all", Status: "Disabled", Expiration: { Days: 1 } }],
            },
          },
        ],
      },
    });

    expect(await listKeys(server, "init-rules")).toEqual(["a"]);
    await server.stop();
  });

  it("sends the lifecycle event at startup for an object that both a rule and objectRetention.maxSeconds expired", async () => {
    let server = await startServer({ port: 0, logger: false, dataDir });
    const { queueArn } = server.createQueue("rule-and-cap-events");
    const s3 = s3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "rule-and-cap" }));
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: "rule-and-cap",
        LifecycleConfiguration: {
          Rules: [{ ID: "all", Status: "Enabled", Filter: {}, Expiration: { Days: 1 } }],
        },
      }),
    );
    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: "rule-and-cap",
        NotificationConfiguration: {
          QueueConfigurations: [{ QueueArn: queueArn, Events: ["s3:LifecycleExpiration:Delete"] }],
        },
      }),
    );
    await s3.send(new PutObjectCommand({ Bucket: "rule-and-cap", Key: "a", Body: "data" }));
    s3.destroy();
    await server.stop();

    vi.setSystemTime(t0 + DAY);
    server = await startServer({
      port: 0,
      logger: false,
      dataDir,
      objectRetention: { maxSeconds: 60 },
    });

    expect(await listKeys(server, "rule-and-cap")).toEqual([]);
    await vi.waitFor(() => {
      const { ready } = server.inspectQueue("rule-and-cap-events")!.messages;
      const records = ready.flatMap((message) => JSON.parse(message.body).Records ?? []);
      expect(records.map((record) => [record.eventName, record.s3.object.key])).toEqual([
        ["LifecycleExpiration:Delete", "a"],
      ]);
    });
    await server.stop();
    expect(countRows(dataDir, "s3_objects")).toBe(0);
  });
});

describe("Persistence: loading SQS messages", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = createTempDir();
  });

  afterEach(async () => {
    await closeOpen();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([
    { kind: "standard", queueName: "paged-load", attributes: {}, fifo: false },
    { kind: "FIFO", queueName: "paged-load.fifo", attributes: { FifoQueue: "true" }, fifo: true },
  ])(
    "restores more $kind messages than one load page holds, in send order",
    async ({ queueName, attributes, fifo }) => {
      const bodies = Array.from({ length: 1205 }, (_, i) => `m${i}`);
      let server = await startServer({ port: 0, logger: false, dataDir });
      server.createQueue(queueName, { attributes });
      for (const body of bodies) {
        server.sendMessage(
          queueName,
          body,
          fifo ? { messageGroupId: "g", messageDeduplicationId: body } : undefined,
        );
      }
      await server.stop();

      server = await startServer({ port: 0, logger: false, dataDir });

      const { ready } = server.inspectQueue(queueName)!.messages;
      expect(ready.map((message) => message.body)).toEqual(bodies);
      await server.stop();
    },
  );

  describe("over the startup heap budget", () => {
    // What one stored message with body "mN" and no attributes ("{}") counts for.
    const messageCost = 2 + 2 + 512;

    async function storeMessages(advanceClock: boolean): Promise<void> {
      vi.useFakeTimers({ toFake: ["Date"], now: t0 });
      const server = await startServer({ port: 0, logger: false, dataDir });
      server.createQueue("budget-a");
      server.createQueue("budget-b");
      for (let i = 0; i < 6; i++) {
        if (advanceClock) vi.setSystemTime(t0 + i * 1000);
        server.sendMessage(i % 2 === 0 ? "budget-a" : "budget-b", `m${i}`);
      }
      await server.stop();
    }

    function load(messageLoadBudgetBytes: number): { warnings: string[]; bodies: string[] } {
      const sqsStore = new SqsStore();
      const persistence = new PersistenceManager(dataDir, { messageLoadBudgetBytes });
      try {
        persistence.load(sqsStore, new SnsStore(), new S3Store());
      } finally {
        persistence.close();
      }
      const bodies = [...sqsStore.allQueues()]
        .flatMap((queue) => queue.messages.map((message) => message.body))
        .sort();
      return { warnings: [...persistence.loadWarnings], bodies };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("deletes the oldest messages of all queues and reports it", async () => {
      await storeMessages(true);

      const { warnings, bodies } = load(messageCost * 3);

      expect(bodies).toEqual(["m3", "m4", "m5"]);
      expect(countRows(dataDir, "sqs_messages")).toBe(3);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Deleted the 3 oldest messages");
    });

    it("keeps the latest stored messages when all were sent in the same millisecond", async () => {
      await storeMessages(false);

      const { bodies } = load(messageCost * 2);

      expect(bodies).toEqual(["m4", "m5"]);
    });

    it("loads everything and reports nothing when the messages fit", async () => {
      await storeMessages(true);

      const { warnings, bodies } = load(messageCost * 6);

      expect(bodies).toHaveLength(6);
      expect(warnings).toEqual([]);
    });
  });
});

describe("Persistence: reclaiming database space", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = createTempDir();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeOpen();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function dbSize(): number {
    return statSync(join(dataDir, "fauxqs.db")).size;
  }

  it("shrinks the database file in the sweep after objects are deleted", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const server = await startServer({ port: 0, logger: false, dataDir });
    const s3 = s3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: "reclaim" }));
    await s3.send(
      new PutObjectCommand({ Bucket: "reclaim", Key: "big", Body: Buffer.alloc(PART_SIZE, "x") }),
    );
    await s3.send(new DeleteObjectCommand({ Bucket: "reclaim", Key: "big" }));
    s3.destroy();

    vi.setSystemTime(t0 + 60_000);
    await fetch(`http://127.0.0.1:${server.port}/health`);

    await vi.waitFor(() => {
      expect(dbSize()).toBeLessThan(1024 * 1024);
    });
    await server.stop();
  });

  it("rebuilds a database created without auto_vacuum at startup", async () => {
    const legacy = new DatabaseSync(join(dataDir, "fauxqs.db"));
    legacy.exec("CREATE TABLE filler (data BLOB)");
    legacy.prepare("INSERT INTO filler (data) VALUES (?)").run(Buffer.alloc(PART_SIZE, "x"));
    legacy.exec("DELETE FROM filler");
    legacy.close();
    expect(dbSize()).toBeGreaterThan(PART_SIZE);

    const server = await startServer({ port: 0, logger: false, dataDir });
    await server.stop();

    expect(dbSize()).toBeLessThan(1024 * 1024);
    expect(queryDb<{ auto_vacuum: number }>(dataDir, "PRAGMA auto_vacuum").auto_vacuum).toBe(2);
  });
});
