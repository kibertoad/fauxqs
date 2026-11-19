import { describe, it, expect } from "vitest";
import { parseLifecycleRules } from "../../src/s3/lifecycle.js";
import { S3Store } from "../../src/s3/s3Store.js";
import type { S3PersistenceProvider } from "../../src/s3/s3Persistence.js";
import { MessageSpy } from "../../src/spy.js";

function rule(body: string): string {
  return `<LifecycleConfiguration><Rule><Status>Enabled</Status>${body}</Rule></LifecycleConfiguration>`;
}

describe("parseLifecycleRules", () => {
  it.each([
    ["2026-07-01", Date.UTC(2026, 6, 1)],
    ["2026-07-01T00:00:00", Date.UTC(2026, 6, 1)],
    ["2026-07-01T00:00:00.000Z", Date.UTC(2026, 6, 1)],
    ["2026-07-01T02:00:00+02:00", Date.UTC(2026, 6, 1)],
  ])("reads the expiration date %s as midnight UTC", (date, expected) => {
    const [parsed] = parseLifecycleRules(rule(`<Expiration><Date>${date}</Date></Expiration>`));
    expect(parsed?.expirationDate).toBe(expected);
  });

  it.each(["2026-07-01T12:00:00Z", "2026-07-01T00:00:00-04:00", "not a date"])(
    "ignores the expiration date %s, which is not midnight UTC",
    (date) => {
      expect(parseLifecycleRules(rule(`<Expiration><Date>${date}</Date></Expiration>`))).toEqual(
        [],
      );
    },
  );

  it.each(["-1", "1.5", "abc"])("skips a rule whose size bound is %s", (bound) => {
    const xml = rule(
      `<Filter><ObjectSizeGreaterThan>${bound}</ObjectSizeGreaterThan></Filter><Expiration><Days>1</Days></Expiration>`,
    );
    expect(parseLifecycleRules(xml)).toEqual([]);
  });

  it("keeps a size bound of zero", () => {
    const xml = rule(
      `<Filter><ObjectSizeGreaterThan>0</ObjectSizeGreaterThan></Filter><Expiration><Days>1</Days></Expiration>`,
    );
    expect(parseLifecycleRules(xml)).toEqual([
      { prefix: "", objectSizeGreaterThan: 0, expirationDays: 1 },
    ]);
  });

  it("skips a rule whose prefix element it cannot read, instead of matching every key", () => {
    const xml = rule(
      `<Filter><Prefix >logs/</Prefix ></Filter><Expiration><Days>1</Days></Expiration>`,
    );
    expect(parseLifecycleRules(xml)).toEqual([]);
  });

  it("reads a self-closing prefix as an empty prefix", () => {
    const xml = rule(`<Filter><Prefix/></Filter><Expiration><Days>1</Days></Expiration>`);
    expect(parseLifecycleRules(xml)).toEqual([{ prefix: "", expirationDays: 1 }]);
  });

  it("skips a rule with a tag filter written with whitespace before >", () => {
    const xml = rule(
      `<Filter><Tag ><Key>k</Key><Value>v</Value></Tag ></Filter><Expiration><Days>1</Days></Expiration>`,
    );
    expect(parseLifecycleRules(xml)).toEqual([]);
  });
});

describe("S3Store.expireObjects with failing persistence", () => {
  const ids: Record<string, string> = {};

  // Two buckets, each with two objects and one upload, all older than maxObjectRetentionMs.
  async function agedStore(persistence: Partial<S3PersistenceProvider>): Promise<S3Store> {
    const store = new S3Store();
    for (const bucket of ["bucket-a", "bucket-b"]) {
      store.createBucket(bucket);
      store.putObject(bucket, "k1", Buffer.from("x"));
      store.putObject(bucket, "k2", Buffer.from("x"));
      ids[bucket] = store.createMultipartUpload(bucket, "upload");
    }
    store.persistence = {
      deleteObjects: () => {},
      deleteMultipartUpload: () => {},
      ...persistence,
    } as unknown as S3PersistenceProvider;
    store.maxObjectRetentionMs = 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return store;
  }

  function keys(store: S3Store, bucket: string): string[] {
    return store.listObjects(bucket).objects.map((object) => object.key);
  }

  it("aborts the uploads of other buckets when aborting one fails, and keeps that one", async () => {
    const store = await agedStore({
      deleteMultipartUpload: (uploadId) => {
        if (uploadId === ids["bucket-a"]) throw new Error("disk busy");
      },
    });

    expect(() => store.expireObjects()).toThrow("disk busy");
    expect(store.getMultipartUpload(ids["bucket-a"])).toBeDefined();
    expect(store.getMultipartUpload(ids["bucket-b"])).toBeUndefined();
    expect(keys(store, "bucket-b")).toEqual([]);
  });

  it("removes from memory each key whose stored data was deleted when the batch delete fails", async () => {
    const store = await agedStore({
      deleteObjects: (bucket, batch) => {
        if (bucket === "bucket-a" && batch.includes("k2")) throw new Error("permission denied");
      },
    });

    expect(() => store.expireObjects()).toThrow("permission denied");
    expect(keys(store, "bucket-a")).toEqual(["k2"]);
    expect(keys(store, "bucket-b")).toEqual([]);
  });
});

describe("S3Store expiry sweep", () => {
  async function agedStore(objectCount: number): Promise<S3Store> {
    const store = new S3Store();
    store.createBucket("aged");
    for (let i = 0; i < objectCount; i++) {
      store.putObject("aged", `k${i}`, Buffer.from("x"));
    }
    store.maxObjectRetentionMs = 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return store;
  }

  it("records a deleted spy entry for each object it expires", async () => {
    const store = await agedStore(2);
    const spy = new MessageSpy();
    store.spy = spy;

    store.expireObjects();

    const deleted = spy
      .getAllMessages()
      .filter((message) => message.service === "s3" && message.status === "deleted")
      .map((message) => (message as { key: string }).key)
      .sort();
    expect(deleted).toEqual(["k0", "k1"]);
  });

  it("lets other callbacks run between steps of a sweep over many objects", async () => {
    const store = await agedStore(12_000);
    let ranDuringSweep = false;
    let sweepDone = false;

    const sweep = store.expireObjectsInSteps().then(() => {
      sweepDone = true;
    });
    setImmediate(() => {
      ranDuringSweep = !sweepDone;
    });
    await sweep;

    expect(ranDuringSweep).toBe(true);
    expect(store.listObjects("aged").objects).toEqual([]);
  });
});
