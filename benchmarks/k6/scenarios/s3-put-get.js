// PutObject followed by a GetObject of the same key. With persistence on, the
// store keeps only metadata in memory, so every GET reads the body back from the
// backend: a file, a SQLite blob or a PostgreSQL bytea.
import { closedLoop, createBucket, getObject, payload, putObject, summaryWriter } from "./lib.js";
import exec from "k6/execution";

export const options = closedLoop();

const BODY = payload(Number(__ENV.OBJECT_BYTES || 65536));
// Keys cycle within a fixed set per VU, so the table and the directory tree stop
// growing after warm-up and later iterations overwrite rather than insert.
const KEYS_PER_VU = Number(__ENV.KEYS_PER_VU || 64);

export function setup() {
  createBucket("bench-objects");
  return { bucket: "bench-objects" };
}

export default function ({ bucket }) {
  const key = `vu-${exec.vu.idInTest}/obj-${exec.vu.iterationInScenario % KEYS_PER_VU}`;
  putObject(bucket, key, BODY);
  getObject(bucket, key);
}

export const handleSummary = summaryWriter;
