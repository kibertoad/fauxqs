import * as assert from "node:assert";
import { chmodSync, mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getLogs, makeS3Client, makeSqsClient, pollHealth, run } from "./dockerTestUtils.ts";

/**
 * Verifies that the Docker image runs the server as an unprivileged user, and
 * that dropping privileges does not break the mount layouts people actually use
 * (root-owned bind mounts, named volumes, read-only mounts, custom --user).
 */

const IMAGE = process.env.FAUXQS_TEST_IMAGE ?? "fauxqs-nonroot-test";
const STAMP = Date.now();
const HOST_PORT = 14569;
const NODE_UID = 1000;

const CONTAINERS: string[] = [];
const VOLUMES: string[] = [];
const TMP_DIRS: string[] = [];

function container(name: string): string {
  const full = `fauxqs-nonroot-${name}-${STAMP}`;
  CONTAINERS.push(full);
  return full;
}

function volume(name: string): string {
  const full = `fauxqs-nonroot-${name}-${STAMP}`;
  VOLUMES.push(full);
  run(`docker volume create ${full}`);
  return full;
}

function hostDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fauxqs-nonroot-${name}-`));
  // World-writable, so the unprivileged user can write to it without the
  // entrypoint taking ownership, and this process can still inspect it after.
  chmodSync(dir, 0o777);
  TMP_DIRS.push(dir);
  return dir;
}

/** Waits for the container to stop and returns its exit code. */
async function waitForExit(name: string, timeoutMs = 30_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = run(`docker inspect -f "{{.State.Running}} {{.State.ExitCode}}" ${name}`);
    const [running, code] = state.trim().split(/\s+/);
    if (running === "false") return Number(code);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Container ${name} was still running after ${timeoutMs}ms`);
}

/**
 * Asserts a *deliberate* refusal to start: the entrypoint's own diagnostic, a
 * non-zero exit, no server launched, and no Node crash. Waiting for the
 * container to stop is not enough on its own — a server that starts and then
 * dies on `ENOENT: mkdir` also stops, and that is the failure mode these
 * scenarios exist to rule out.
 */
async function assertRefusedToStart(name: string, expected: string[]): Promise<void> {
  const code = await waitForExit(name);
  const logs = getLogs(name);
  assert.notStrictEqual(code, 0, `Expected a non-zero exit code.\nLogs:\n${logs}`);
  for (const line of expected) {
    assert.ok(logs.includes(line), `Expected ${JSON.stringify(line)} in logs.\nLogs:\n${logs}`);
  }
  assert.ok(
    !logs.includes("Server user:"),
    `The server was started despite the unusable configuration.\nLogs:\n${logs}`,
  );
  assert.ok(
    !logs.includes("ENOENT") && !/^\s+at .+\(/m.test(logs),
    `Expected a clean refusal, not a Node crash.\nLogs:\n${logs}`,
  );
  console.log(`  Refused to start with a diagnostic (exit ${code}): OK`);
}

/**
 * PID 1 is always tini, exec'd as the user the server runs as (su-exec runs
 * before tini), so its uid is the server's effective uid.
 */
function serverUid(name: string): number {
  const status = run(`docker exec ${name} cat /proc/1/status`);
  const line = status.split("\n").find((l) => l.startsWith("Uid:"));
  assert.ok(line, `No Uid line in /proc/1/status:\n${status}`);
  const uid = Number(line.trim().split(/\s+/)[1]);
  assert.ok(Number.isInteger(uid), `Could not parse uid from "${line}"`);
  return uid;
}

/** Owner name of the process actually running the server, as reported by ps. */
function serverProcessOwner(name: string): string {
  const ps = run(`docker exec ${name} ps -o user,args`);
  const line = ps
    .split("\n")
    .find((l) => l.includes("node dist/server.js") && !l.includes("tini"));
  assert.ok(line, `Server process not found in ps output:\n${ps}`);
  return line.trim().split(/\s+/)[0]!;
}

function assertNonRoot(name: string, expectedUid = NODE_UID): void {
  const uid = serverUid(name);
  assert.strictEqual(uid, expectedUid, `Expected server to run as uid ${expectedUid}, got ${uid}`);
  const owner = serverProcessOwner(name);
  assert.notStrictEqual(owner, "root", `Server process is owned by root: ${owner}`);
  console.log(`  Server runs as uid ${uid} (${owner}): OK`);
}

/**
 * Numeric owner uid of each entry in a container directory, dotfiles included:
 * `seedRootOwnedVolume` plants a root-owned `.keep`, so a listing without -a
 * would not notice a chown that stopped being recursive. The `.` and `..`
 * entries that -a adds are dropped again.
 */
function dirOwnerUids(name: string, dir: string): number[] {
  const listing = run(`docker exec ${name} ls -lan ${dir}`);
  return listing
    .split("\n")
    .filter((l) => /^[-d]/.test(l) && !/\s\.\.?$/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[2]));
}

/** Makes a volume look like a root-owned host bind mount. */
function seedRootOwnedVolume(vol: string, mountPath: string): void {
  run(
    `docker run --rm --user 0:0 --entrypoint sh -v ${vol}:${mountPath} ${IMAGE} ` +
      `-c "touch ${mountPath}/.keep && chown -R root:root ${mountPath} && chmod 755 ${mountPath}"`,
  );
}

function banner(title: string): void {
  console.log("\n══════════════════════════════════════");
  console.log(`  ${title}`);
  console.log("══════════════════════════════════════\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: default run — unprivileged server, working DNS and API
// ─────────────────────────────────────────────────────────────────────────────
async function testDefaultRun(): Promise<void> {
  banner("Scenario 1: default run drops privileges");

  const name = container("default");
  const hostname = "fauxqs-default";
  run(`docker run -d --name ${name} --hostname ${hostname} -p ${HOST_PORT}:4566 ${IMAGE}`);
  await pollHealth(HOST_PORT, name);

  const logs = getLogs(name);
  assert.ok(
    logs.includes("Server user: node"),
    `Expected "Server user: node" in logs.\nLogs:\n${logs}`,
  );
  assertNonRoot(name);

  // dnsmasq still owns port 53 after the drop (it is started while still root).
  const dns = run(`docker exec ${name} nslookup my-bucket.s3.${hostname} 127.0.0.1`);
  assert.ok(
    dns.includes(`my-bucket.s3.${hostname}`),
    `Wildcard DNS did not resolve after dropping privileges:\n${dns}`,
  );
  console.log("  Wildcard DNS resolves: OK");

  // The API works end to end as the unprivileged user.
  const s3 = makeS3Client(HOST_PORT);
  await s3.send(new CreateBucketCommand({ Bucket: "nonroot-bucket" }));
  await s3.send(
    new PutObjectCommand({ Bucket: "nonroot-bucket", Key: "k.txt", Body: "unprivileged" }),
  );
  const got = await s3.send(new GetObjectCommand({ Bucket: "nonroot-bucket", Key: "k.txt" }));
  assert.strictEqual(await got.Body!.transformToString(), "unprivileged");
  console.log("  S3 put/get as unprivileged user: OK");

  run(`docker rm -f ${name}`);
  console.log("\nScenario 1 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: root-owned data mount (the `-v ./volume:/data` case)
// ─────────────────────────────────────────────────────────────────────────────
async function testRootOwnedDataMount(): Promise<void> {
  banner("Scenario 2: root-owned data mount + persistence");

  const vol = volume("rootvol");
  seedRootOwnedVolume(vol, "/data");

  const first = container("rootvol-1");
  run(
    `docker run -d --name ${first} -p ${HOST_PORT}:4566 ` +
      `-e FAUXQS_PERSISTENCE=true -v ${vol}:/data ${IMAGE}`,
  );
  await pollHealth(HOST_PORT, first);
  console.log("  Container with root-owned /data is healthy: OK");
  assertNonRoot(first);

  const sqs = makeSqsClient(HOST_PORT);
  const s3 = makeS3Client(HOST_PORT);
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: "nonroot-q" }));
  await sqs.send(
    new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "survive-restart" }),
  );
  await s3.send(new CreateBucketCommand({ Bucket: "nonroot-persist" }));
  await s3.send(
    new PutObjectCommand({ Bucket: "nonroot-persist", Key: "o.txt", Body: "persisted" }),
  );

  // The database files must belong to the unprivileged user, not root.
  const uids = dirOwnerUids(first, "/data");
  assert.ok(
    uids.length > 0 && uids.every((uid) => uid === NODE_UID),
    `Expected every file in /data to be owned by uid ${NODE_UID}, got ${JSON.stringify(uids)}`,
  );
  console.log(`  /data contents owned by uid ${NODE_UID}: OK`);

  run(`docker stop ${first}`);
  run(`docker rm -f ${first}`);

  const second = container("rootvol-2");
  run(
    `docker run -d --name ${second} -p ${HOST_PORT}:4566 ` +
      `-e FAUXQS_PERSISTENCE=true -v ${vol}:/data ${IMAGE}`,
  );
  await pollHealth(HOST_PORT, second);
  assertNonRoot(second);

  const sqs2 = makeSqsClient(HOST_PORT);
  const s32 = makeS3Client(HOST_PORT);
  const restored = await sqs2.send(new GetQueueUrlCommand({ QueueName: "nonroot-q" }));
  const received = await sqs2.send(
    new ReceiveMessageCommand({ QueueUrl: restored.QueueUrl!, MaxNumberOfMessages: 1 }),
  );
  assert.strictEqual(received.Messages?.[0]?.Body, "survive-restart", "SQS message did not survive");
  const object = await s32.send(
    new GetObjectCommand({ Bucket: "nonroot-persist", Key: "o.txt" }),
  );
  assert.strictEqual(await object.Body!.transformToString(), "persisted", "S3 object did not survive");
  console.log("  State survived restart: OK");

  run(`docker rm -f ${second}`);
  console.log("\nScenario 2 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: host bind mount + mounted init config
// ─────────────────────────────────────────────────────────────────────────────
async function testHostBindMount(): Promise<void> {
  banner("Scenario 3: host bind mount + mounted init config");

  const dataDir = hostDir("data");
  const initDir = hostDir("init");
  const initFile = join(initDir, "init.json");
  writeFileSync(initFile, JSON.stringify({ queues: [{ name: "from-init" }] }));

  const name = container("bindmount");
  run(
    `docker run -d --name ${name} -p ${HOST_PORT}:4566 ` +
      `-e FAUXQS_PERSISTENCE=true -e FAUXQS_INIT=/app/init.json ` +
      `-v "${dataDir}":/data -v "${initFile}":/app/init.json:ro ${IMAGE}`,
  );
  await pollHealth(HOST_PORT, name);
  assertNonRoot(name);

  // A read-only, root-owned init file must still be readable after the drop.
  const sqs = makeSqsClient(HOST_PORT);
  const fromInit = await sqs.send(new GetQueueUrlCommand({ QueueName: "from-init" }));
  assert.ok(fromInit.QueueUrl, "Queue from the mounted init config was not created");
  console.log("  Mounted read-only init config was applied: OK");

  await sqs.send(new SendMessageCommand({ QueueUrl: fromInit.QueueUrl!, MessageBody: "hello" }));

  // Persistence actually landed on the host directory.
  const hostFiles = readdirSync(dataDir);
  assert.ok(
    hostFiles.some((f) => f.startsWith("fauxqs.db")),
    `Expected a SQLite database in the bind-mounted host directory, saw: ${hostFiles.join(", ")}`,
  );
  console.log(`  Database written to host bind mount (${hostFiles.join(", ")}): OK`);

  run(`docker rm -f ${name}`);
  console.log("\nScenario 3 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: container started as non-root (docker run --user / runAsUser)
// ─────────────────────────────────────────────────────────────────────────────
async function testStartedAsNonRoot(): Promise<void> {
  banner("Scenario 4: container started with --user (no root phase)");

  const vol = volume("useropt");
  const name = container("useropt");
  const hostname = "fauxqs-useropt";
  run(
    `docker run -d --name ${name} --hostname ${hostname} --user ${NODE_UID}:${NODE_UID} ` +
      `-p ${HOST_PORT}:4566 -e FAUXQS_PERSISTENCE=true -v ${vol}:/data ${IMAGE}`,
  );
  await pollHealth(HOST_PORT, name);

  const logs = getLogs(name);
  assert.ok(
    logs.includes("container started as non-root"),
    `Expected the non-root startup path in logs.\nLogs:\n${logs}`,
  );
  assertNonRoot(name);

  // Proves dnsmasq's file capability: binding port 53 without ever being root.
  const dns = run(`docker exec ${name} nslookup b.s3.${hostname} 127.0.0.1`);
  assert.ok(dns.includes(`b.s3.${hostname}`), `Wildcard DNS did not resolve:\n${dns}`);
  console.log("  dnsmasq bound port 53 without root: OK");

  // An empty named volume inherits /data's ownership from the image, so
  // persistence works even though the entrypoint could not chown anything.
  const sqs = makeSqsClient(HOST_PORT);
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: "useropt-q" }));
  await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "keep" }));
  run(`docker stop ${name}`);
  run(`docker rm -f ${name}`);

  const second = container("useropt-2");
  run(
    `docker run -d --name ${second} --user ${NODE_UID}:${NODE_UID} ` +
      `-p ${HOST_PORT}:4566 -e FAUXQS_PERSISTENCE=true -v ${vol}:/data ${IMAGE}`,
  );
  await pollHealth(HOST_PORT, second);
  const sqs2 = makeSqsClient(HOST_PORT);
  const restored = await sqs2.send(new GetQueueUrlCommand({ QueueName: "useropt-q" }));
  const received = await sqs2.send(
    new ReceiveMessageCommand({ QueueUrl: restored.QueueUrl!, MaxNumberOfMessages: 1 }),
  );
  assert.strictEqual(received.Messages?.[0]?.Body, "keep", "SQS message did not survive restart");
  console.log("  Persistence works under --user: OK");

  run(`docker rm -f ${second}`);
  console.log("\nScenario 4 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: FAUXQS_RUN_USER selects a different unprivileged user
// ─────────────────────────────────────────────────────────────────────────────
async function testCustomRunUser(): Promise<void> {
  banner("Scenario 5: FAUXQS_RUN_USER=1001 on a root-owned mount");

  const vol = volume("customuser");
  seedRootOwnedVolume(vol, "/data");

  const name = container("customuser");
  run(
    `docker run -d --name ${name} -p ${HOST_PORT}:4566 -e FAUXQS_RUN_USER=1001 ` +
      `-e FAUXQS_PERSISTENCE=true -v ${vol}:/data ${IMAGE}`,
  );
  await pollHealth(HOST_PORT, name);
  assertNonRoot(name, 1001);

  const uids = dirOwnerUids(name, "/data");
  assert.ok(
    uids.length > 0 && uids.every((uid) => uid === 1001),
    `Expected /data to be handed to uid 1001, got ${JSON.stringify(uids)}`,
  );

  const sqs = makeSqsClient(HOST_PORT);
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: "custom-user-q" }));
  await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "written" }));
  console.log("  Writes to the chowned volume as uid 1001: OK");

  run(`docker rm -f ${name}`);
  console.log("\nScenario 5 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6: FAUXQS_RUN_AS_ROOT opts back into the old behaviour
// ─────────────────────────────────────────────────────────────────────────────
async function testRunAsRootOptIn(): Promise<void> {
  banner("Scenario 6: FAUXQS_RUN_AS_ROOT=true escape hatch");

  const name = container("asroot");
  run(
    `docker run -d --name ${name} -p ${HOST_PORT}:4566 -e FAUXQS_RUN_AS_ROOT=true ${IMAGE}`,
  );
  await pollHealth(HOST_PORT, name);

  const logs = getLogs(name);
  assert.ok(
    logs.includes("Server user: root (FAUXQS_RUN_AS_ROOT=true)"),
    `Expected the opt-in root message in logs.\nLogs:\n${logs}`,
  );
  assert.strictEqual(serverUid(name), 0, "Expected the server to run as root");
  console.log("  Server runs as root on request: OK");

  run(`docker rm -f ${name}`);
  console.log("\nScenario 6 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7: a read-only write directory is refused, not worked around
// ─────────────────────────────────────────────────────────────────────────────
async function testReadOnlyMountRefused(): Promise<void> {
  banner("Scenario 7: read-only mount refuses to start with a diagnostic");

  const vol = volume("readonly");
  seedRootOwnedVolume(vol, "/s3data");

  const name = container("readonly");
  run(
    `docker run -d --name ${name} -p ${HOST_PORT}:4566 ` +
      `-e FAUXQS_S3_STORAGE_DIR=/s3data -v ${vol}:/s3data:ro ${IMAGE}`,
  );

  // Neither chown nor a fallback to root can fix a read-only mount, so the
  // entrypoint has to say so instead of starting a server that would fail on
  // its first write. The chown error itself must reach the logs too.
  await assertRefusedToStart(name, [
    "WARNING: /s3data could not be handed over to 'node'.",
    "WARNING: chown said:",
    "Read-only file system",
    "ERROR: /s3data is writable by neither 'node' nor root",
  ]);

  run(`docker rm -f ${name}`);
  console.log("\nScenario 7 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8: --user with a mount it cannot write is caught at startup
// ─────────────────────────────────────────────────────────────────────────────
async function testStartedAsNonRootUnwritableMount(): Promise<void> {
  banner("Scenario 8: --user + root-owned mount is refused at startup");

  // The gap scenario 4 cannot cover: it uses an *empty* named volume, which
  // inherits the image's ownership. A populated root-owned mount leaves the
  // entrypoint no way to fix anything — it has no privileges to chown with —
  // and SQLite would happily open the database read-only and then fail every
  // write with "attempt to write a readonly database" behind a 200 /health.
  const vol = volume("userunwritable");
  seedRootOwnedVolume(vol, "/data");

  const name = container("userunwritable");
  run(
    `docker run -d --name ${name} --user ${NODE_UID}:${NODE_UID} ` +
      `-e FAUXQS_PERSISTENCE=true -v ${vol}:/data ${IMAGE}`,
  );

  await assertRefusedToStart(name, [
    `ERROR: /data is not writable by uid ${NODE_UID}.`,
    "ERROR: The container was started as a non-root user",
  ]);

  run(`docker rm -f ${name}`);
  console.log("\nScenario 8 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9: an unusable FAUXQS_RUN_USER is rejected, never silently root
// ─────────────────────────────────────────────────────────────────────────────
async function testInvalidRunUserRejected(): Promise<void> {
  banner("Scenario 9: unusable FAUXQS_RUN_USER is rejected");

  // A typo used to be read as "the mount is not writable", which fell back to
  // running the whole server as root — the exact opposite of what the variable
  // was set to do — or killed the container with a raw su-exec error, depending
  // on whether a write directory happened to be configured.
  const vol = volume("baduser");
  seedRootOwnedVolume(vol, "/data");

  const withMount = container("baduser-mount");
  run(
    `docker run -d --name ${withMount} -e FAUXQS_RUN_USER=nosuchuser ` +
      `-e FAUXQS_PERSISTENCE=true -v ${vol}:/data ${IMAGE}`,
  );
  await assertRefusedToStart(withMount, [
    "ERROR: FAUXQS_RUN_USER='nosuchuser' cannot be used to run the server.",
  ]);
  run(`docker rm -f ${withMount}`);

  const withoutMount = container("baduser-plain");
  run(`docker run -d --name ${withoutMount} -e FAUXQS_RUN_USER=nosuchuser ${IMAGE}`);
  await assertRefusedToStart(withoutMount, [
    "ERROR: FAUXQS_RUN_USER='nosuchuser' cannot be used to run the server.",
  ]);
  run(`docker rm -f ${withoutMount}`);

  console.log("\nScenario 9 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 10: --cap-drop=ALL (Kubernetes' restricted policy) still starts
// ─────────────────────────────────────────────────────────────────────────────
async function testAllCapabilitiesDropped(): Promise<void> {
  banner("Scenario 10: --user with --cap-drop=ALL");

  // The restricted Pod Security Standard pairs runAsNonRoot with dropping every
  // capability. dnsmasq's cap_net_bind_service+ep made execve itself fail with
  // EPERM there, taking the whole container down with exit 126 before the
  // server ever started. Wildcard DNS may legitimately be unavailable — the API
  // must not be.
  const name = container("nocaps");
  const hostname = "fauxqs-nocaps";
  run(
    `docker run -d --name ${name} --hostname ${hostname} --user ${NODE_UID}:${NODE_UID} ` +
      `--cap-drop=ALL -p ${HOST_PORT}:4566 ${IMAGE}`,
  );
  await pollHealth(HOST_PORT, name);
  assertNonRoot(name);

  const s3 = makeS3Client(HOST_PORT);
  await s3.send(new CreateBucketCommand({ Bucket: "nocaps-bucket" }));
  await s3.send(new PutObjectCommand({ Bucket: "nocaps-bucket", Key: "k", Body: "no-caps" }));
  const got = await s3.send(new GetObjectCommand({ Bucket: "nocaps-bucket", Key: "k" }));
  assert.strictEqual(await got.Body!.transformToString(), "no-caps");
  console.log("  API works with every capability dropped: OK");

  // Whether port 53 is bindable depends on net.ipv4.ip_unprivileged_port_start,
  // so accept either outcome — but an unavailable DNS has to be reported.
  const logs = getLogs(name);
  if (logs.includes("WARNING: dnsmasq could not bind port 53")) {
    assert.ok(
      logs.includes("WARNING: Add the NET_BIND_SERVICE capability"),
      `Expected the capability hint alongside the DNS warning.\nLogs:\n${logs}`,
    );
    console.log("  Wildcard DNS unavailable, and said so: OK");
  } else {
    const dns = run(`docker exec ${name} nslookup b.s3.${hostname} 127.0.0.1`);
    assert.ok(dns.includes(`b.s3.${hostname}`), `Wildcard DNS did not resolve:\n${dns}`);
    console.log("  Wildcard DNS resolves without any capability: OK");
  }

  run(`docker rm -f ${name}`);
  console.log("\nScenario 10 PASSED");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 11: an already-writable mount keeps its ownership
// ─────────────────────────────────────────────────────────────────────────────
async function testWritableMountIsNotChowned(): Promise<void> {
  banner("Scenario 11: an already-writable mount is left alone");

  // `chown -R` on a bind mount rewrites the ownership of the host's files
  // irreversibly, so it must only happen when it is actually needed. A mount
  // that the unprivileged user can already write through its group must come
  // out the other side owned by exactly who owned it going in.
  const OTHER_UID = 1002;
  const vol = volume("groupwritable");
  run(
    `docker run --rm --user 0:0 --entrypoint sh -v ${vol}:/data ${IMAGE} ` +
      `-c "touch /data/pre.txt && chown -R ${OTHER_UID}:${NODE_UID} /data ` +
      `&& chmod 775 /data && chmod 664 /data/pre.txt"`,
  );

  const name = container("groupwritable");
  run(
    `docker run -d --name ${name} -p ${HOST_PORT}:4566 ` +
      `-e FAUXQS_PERSISTENCE=true -v ${vol}:/data ${IMAGE}`,
  );
  await pollHealth(HOST_PORT, name);
  assertNonRoot(name);

  const preOwner = run(`docker exec ${name} stat -c %u /data/pre.txt`).trim();
  assert.strictEqual(
    Number(preOwner),
    OTHER_UID,
    `The pre-existing file was chowned from ${OTHER_UID} to ${preOwner}`,
  );
  const dirOwner = run(`docker exec ${name} stat -c %u /data`).trim();
  assert.strictEqual(
    Number(dirOwner),
    OTHER_UID,
    `The mount itself was chowned from ${OTHER_UID} to ${dirOwner}`,
  );
  console.log(`  Ownership left at uid ${OTHER_UID}: OK`);

  // ...and the server can still write, which is why no chown was needed.
  const sqs = makeSqsClient(HOST_PORT);
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: "group-writable-q" }));
  await sqs.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: "grouped" }));
  console.log("  Persistence works through group permissions: OK");

  run(`docker rm -f ${name}`);
  console.log("\nScenario 11 PASSED");
}

async function main(): Promise<void> {
  if (!process.env.FAUXQS_TEST_IMAGE) {
    console.log("Building Docker image...");
    run(`docker build -t ${IMAGE} .`);
  }

  await testDefaultRun();
  await testRootOwnedDataMount();
  await testHostBindMount();
  await testStartedAsNonRoot();
  await testCustomRunUser();
  await testRunAsRootOptIn();
  await testReadOnlyMountRefused();
  await testStartedAsNonRootUnwritableMount();
  await testInvalidRunUserRejected();
  await testAllCapabilitiesDropped();
  await testWritableMountIsNotChowned();

  console.log("\n══════════════════════════════════════");
  console.log("  All non-root acceptance tests passed!");
  console.log("══════════════════════════════════════\n");
}

main()
  .catch((err) => {
    console.error("\nNon-root acceptance test FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log("Cleaning up...");
    for (const name of CONTAINERS) {
      try {
        run(`docker rm -f ${name}`);
      } catch {
        /* already gone */
      }
    }
    for (const vol of VOLUMES) {
      try {
        run(`docker volume rm -f ${vol}`);
      } catch {
        /* already gone */
      }
    }
    for (const dir of TMP_DIRS) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort — root-owned leftovers are possible */
      }
    }
  });
