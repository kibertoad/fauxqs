import * as assert from "node:assert";
import { execSync } from "node:child_process";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";

const IMAGE = process.env.FAUXQS_TEST_IMAGE ?? "fauxqs-s3-storage-test";
const VOLUME_NAME = `fauxqs-s3-test-${Date.now()}`;
const CONTAINER_PREFIX = `fauxqs-s3-${Date.now()}`;
const NO_VOL_CONTAINER = `fauxqs-s3-novol-${Date.now()}`;
const MIXED_VOLUME_DATA = `fauxqs-mixed-data-${Date.now()}`;
const MIXED_VOLUME_S3 = `fauxqs-mixed-s3-${Date.now()}`;
const MIXED_CONTAINER = `fauxqs-mixed-${Date.now()}`;
const COMPOSE_PROJECT = `fauxqs-compose-s3-${Date.now()}`;
const COMPOSE_FILE = "docker-acceptance/docker-compose.s3-storage.yml";
const HOST_PORT = 14568;

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function runWithEnv(cmd: string, env: Record<string, string>): string {
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
}

function getLogs(containerName: string): string {
  try {
    return run(`docker logs ${containerName} 2>&1`);
  } catch {
    return "(could not retrieve logs)";
  }
}

async function pollHealth(port: number, containerName: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  const url = `http://localhost:${port}/health`;
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`Health check returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("Container logs:\n" + getLogs(containerName));
  throw new Error(`Health check timed out after ${timeoutMs}ms (last error: ${lastError})`);
}

function makeS3Client(port: number): S3Client {
  return new S3Client({
    endpoint: `http://localhost:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
  });
}

function makeSqsClient(port: number): SQSClient {
  return new SQSClient({
    endpoint: `http://localhost:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 1: S3 file storage with volume — state survives restart
// ──────────────────────────────────────────────────────────────────────────────

async function testS3StorageWithVolume(): Promise<void> {
  console.log("\n══════════════════════════════════════");
  console.log("  Scenario 1: S3 file storage with volume — state survives restart");
  console.log("══════════════════════════════════════\n");

  // Create named volume
  console.log(`Creating volume: ${VOLUME_NAME}`);
  run(`docker volume create ${VOLUME_NAME}`);

  // ── Phase 1: Start container with S3 storage dir ──
  console.log("Starting container 1 with volume + FAUXQS_S3_STORAGE_DIR...");
  run(
    `docker run -d --name ${CONTAINER_PREFIX}-1 -p ${HOST_PORT}:4566 -e FAUXQS_S3_STORAGE_DIR=/s3data -v ${VOLUME_NAME}:/s3data ${IMAGE}`,
  );

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, `${CONTAINER_PREFIX}-1`);
  console.log("Container 1 healthy.");

  // Verify S3 file storage is ON
  const logs1 = getLogs(`${CONTAINER_PREFIX}-1`);
  assert.ok(
    logs1.includes("S3 file storage: ON"),
    `Expected "S3 file storage: ON" in container logs.\nLogs:\n${logs1}`,
  );
  console.log("S3 file storage status log: OK");

  const s3 = makeS3Client(HOST_PORT);

  // Create bucket and upload objects
  console.log("Creating S3 bucket and uploading objects...");
  await s3.send(new CreateBucketCommand({ Bucket: "s3-persist-bucket" }));
  await s3.send(
    new PutObjectCommand({
      Bucket: "s3-persist-bucket",
      Key: "test.txt",
      Body: "Hello from S3 file storage test!",
      ContentType: "text/plain",
    }),
  );
  // Upload object with slashes (nested key) to test directory structure
  await s3.send(
    new PutObjectCommand({
      Bucket: "s3-persist-bucket",
      Key: "photos/vacation.jpg",
      Body: "fake-jpeg-data",
      ContentType: "image/jpeg",
    }),
  );

  // Verify objects are retrievable before restart
  console.log("Verifying objects before restart...");
  const obj1 = await s3.send(
    new GetObjectCommand({ Bucket: "s3-persist-bucket", Key: "test.txt" }),
  );
  assert.strictEqual(await obj1.Body!.transformToString(), "Hello from S3 file storage test!");
  const obj2 = await s3.send(
    new GetObjectCommand({ Bucket: "s3-persist-bucket", Key: "photos/vacation.jpg" }),
  );
  assert.strictEqual(await obj2.Body!.transformToString(), "fake-jpeg-data");
  console.log("Objects retrievable before restart: OK");

  // ── Phase 2: Stop container ──
  console.log("Stopping container 1...");
  run(`docker stop ${CONTAINER_PREFIX}-1`);
  console.log("Container 1 stopped.");

  // ── Phase 3: Start NEW container with same volume ──
  console.log("Starting container 2 with same volume + FAUXQS_S3_STORAGE_DIR...");
  run(
    `docker run -d --name ${CONTAINER_PREFIX}-2 -p ${HOST_PORT}:4566 -e FAUXQS_S3_STORAGE_DIR=/s3data -v ${VOLUME_NAME}:/s3data ${IMAGE}`,
  );

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, `${CONTAINER_PREFIX}-2`);
  console.log("Container 2 healthy.");

  const s32 = makeS3Client(HOST_PORT);

  // ── Phase 4: Verify state survived ──
  console.log("Verifying S3 bucket survived...");
  const buckets = await s32.send(new ListBucketsCommand({}));
  assert.ok(
    buckets.Buckets?.some((b) => b.Name === "s3-persist-bucket"),
    "Expected s3-persist-bucket to exist after restart",
  );
  console.log("S3 bucket exists: OK");

  console.log("Verifying S3 objects survived...");
  const objAfter1 = await s32.send(
    new GetObjectCommand({ Bucket: "s3-persist-bucket", Key: "test.txt" }),
  );
  const body1 = await objAfter1.Body!.transformToString();
  assert.strictEqual(body1, "Hello from S3 file storage test!", "S3 body mismatch for test.txt");
  assert.strictEqual(objAfter1.ContentType, "text/plain", "S3 content-type mismatch for test.txt");
  console.log("S3 object test.txt verified: OK");

  console.log("Verifying nested key (photos/vacation.jpg) survived...");
  const objAfter2 = await s32.send(
    new GetObjectCommand({ Bucket: "s3-persist-bucket", Key: "photos/vacation.jpg" }),
  );
  const body2 = await objAfter2.Body!.transformToString();
  assert.strictEqual(body2, "fake-jpeg-data", "S3 body mismatch for photos/vacation.jpg");
  assert.strictEqual(objAfter2.ContentType, "image/jpeg", "S3 content-type mismatch for photos/vacation.jpg");
  console.log("S3 object photos/vacation.jpg verified: OK");

  // List objects to verify all survived
  const list = await s32.send(
    new ListObjectsV2Command({ Bucket: "s3-persist-bucket" }),
  );
  assert.strictEqual(list.KeyCount, 2, `Expected 2 objects, got ${list.KeyCount}`);
  console.log("S3 object count verified: OK");

  console.log("\nScenario 1 PASSED: S3 file storage state survived restart with volume.");

  // Cleanup
  try { run(`docker rm -f ${CONTAINER_PREFIX}-1`); } catch { /* ignore */ }
  try { run(`docker rm -f ${CONTAINER_PREFIX}-2`); } catch { /* ignore */ }
  try { run(`docker volume rm ${VOLUME_NAME}`); } catch { /* ignore */ }
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 2: S3 file storage without volume — disabled
// ──────────────────────────────────────────────────────────────────────────────

async function testS3StorageWithoutVolume(): Promise<void> {
  console.log("\n══════════════════════════════════════");
  console.log("  Scenario 2: S3 file storage without volume — disabled");
  console.log("══════════════════════════════════════\n");

  // ── Phase 1: Start container with env but NO volume ──
  console.log("Starting container with FAUXQS_S3_STORAGE_DIR but no volume...");
  run(
    `docker run -d --name ${NO_VOL_CONTAINER} -p ${HOST_PORT}:4566 -e FAUXQS_S3_STORAGE_DIR=/s3data ${IMAGE}`,
  );

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, NO_VOL_CONTAINER);
  console.log("Container healthy.");

  // Verify entrypoint detected missing volume
  const logs = getLogs(NO_VOL_CONTAINER);
  assert.ok(
    logs.includes("No volume mounted at /s3data"),
    `Expected "No volume mounted at /s3data" in container logs.\nLogs:\n${logs}`,
  );
  assert.ok(
    logs.includes("S3 file storage: OFF"),
    `Expected "S3 file storage: OFF" in container logs.\nLogs:\n${logs}`,
  );
  console.log("S3 file storage disabled log message: OK");

  const s3 = makeS3Client(HOST_PORT);

  // ── Phase 2: Verify S3 still works (in-memory) ──
  console.log("Creating S3 bucket and uploading object (in-memory)...");
  await s3.send(new CreateBucketCommand({ Bucket: "novol-s3-bucket" }));
  await s3.send(
    new PutObjectCommand({
      Bucket: "novol-s3-bucket",
      Key: "ephemeral.txt",
      Body: "This should vanish",
      ContentType: "text/plain",
    }),
  );

  const obj = await s3.send(
    new GetObjectCommand({ Bucket: "novol-s3-bucket", Key: "ephemeral.txt" }),
  );
  assert.strictEqual(await obj.Body!.transformToString(), "This should vanish");
  console.log("S3 works in-memory (no file storage): OK");

  // ── Phase 3: docker stop + docker start ──
  console.log("Stopping container (docker stop)...");
  run(`docker stop ${NO_VOL_CONTAINER}`);
  console.log("Container stopped.");

  console.log("Restarting same container (docker start)...");
  run(`docker start ${NO_VOL_CONTAINER}`);

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, NO_VOL_CONTAINER);
  console.log("Container healthy after restart.");

  // ── Phase 4: Verify state is GONE ──
  const s32 = makeS3Client(HOST_PORT);

  console.log("Verifying S3 state is gone...");
  const buckets = await s32.send(new ListBucketsCommand({}));
  assert.strictEqual(
    buckets.Buckets?.length ?? 0,
    0,
    `Expected no buckets after restart without volume, got: ${buckets.Buckets?.map((b) => b.Name).join(", ")}`,
  );
  console.log("S3: no buckets (no persistence): OK");

  console.log("\nScenario 2 PASSED: S3 file storage disabled without volume.");

  // Cleanup
  try { run(`docker rm -f ${NO_VOL_CONTAINER}`); } catch { /* ignore */ }
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 3: Mixed mode (dataDir + s3StorageDir)
// ──────────────────────────────────────────────────────────────────────────────

async function testMixedMode(): Promise<void> {
  console.log("\n══════════════════════════════════════");
  console.log("  Scenario 3: Mixed mode — SQS via SQLite, S3 via files");
  console.log("══════════════════════════════════════\n");

  // Create named volumes
  console.log(`Creating volumes: ${MIXED_VOLUME_DATA}, ${MIXED_VOLUME_S3}`);
  run(`docker volume create ${MIXED_VOLUME_DATA}`);
  run(`docker volume create ${MIXED_VOLUME_S3}`);

  // ── Phase 1: Start container with both persistence and S3 file storage ──
  console.log("Starting container 1 with both volumes + FAUXQS_PERSISTENCE=true + FAUXQS_S3_STORAGE_DIR...");
  run(
    `docker run -d --name ${MIXED_CONTAINER}-1 -p ${HOST_PORT}:4566 ` +
    `-e FAUXQS_PERSISTENCE=true -e FAUXQS_S3_STORAGE_DIR=/s3data ` +
    `-v ${MIXED_VOLUME_DATA}:/data -v ${MIXED_VOLUME_S3}:/s3data ${IMAGE}`,
  );

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, `${MIXED_CONTAINER}-1`);
  console.log("Container 1 healthy.");

  // Verify both modes are ON
  const logs1 = getLogs(`${MIXED_CONTAINER}-1`);
  assert.ok(
    logs1.includes("Persistence: ON"),
    `Expected "Persistence: ON" in container logs.\nLogs:\n${logs1}`,
  );
  assert.ok(
    logs1.includes("S3 file storage: ON"),
    `Expected "S3 file storage: ON" in container logs.\nLogs:\n${logs1}`,
  );
  console.log("Both persistence and S3 file storage ON: OK");

  const sqs = makeSqsClient(HOST_PORT);
  const s3 = makeS3Client(HOST_PORT);

  // Create SQS queue + send message
  console.log("Creating SQS queue and sending message...");
  const createQueueResult = await sqs.send(new CreateQueueCommand({ QueueName: "mixed-q" }));
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: createQueueResult.QueueUrl!,
      MessageBody: "mixed-mode-message",
    }),
  );

  // Create S3 bucket + upload object
  console.log("Creating S3 bucket and uploading object...");
  await s3.send(new CreateBucketCommand({ Bucket: "mixed-bucket" }));
  await s3.send(
    new PutObjectCommand({
      Bucket: "mixed-bucket",
      Key: "mixed.txt",
      Body: "Mixed mode data",
      ContentType: "text/plain",
    }),
  );

  // ── Phase 2: Stop container ──
  console.log("Stopping container 1...");
  run(`docker stop ${MIXED_CONTAINER}-1`);
  console.log("Container 1 stopped.");

  // ── Phase 3: Start NEW container with same volumes ──
  console.log("Starting container 2 with same volumes...");
  run(
    `docker run -d --name ${MIXED_CONTAINER}-2 -p ${HOST_PORT}:4566 ` +
    `-e FAUXQS_PERSISTENCE=true -e FAUXQS_S3_STORAGE_DIR=/s3data ` +
    `-v ${MIXED_VOLUME_DATA}:/data -v ${MIXED_VOLUME_S3}:/s3data ${IMAGE}`,
  );

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, `${MIXED_CONTAINER}-2`);
  console.log("Container 2 healthy.");

  const sqs2 = makeSqsClient(HOST_PORT);
  const s32 = makeS3Client(HOST_PORT);

  // ── Phase 4: Verify SQS message survived (via SQLite) ──
  console.log("Verifying SQS message survived...");
  const recv = await sqs2.send(
    new ReceiveMessageCommand({
      QueueUrl: `http://sqs.us-east-1.localhost:${HOST_PORT}/000000000000/mixed-q`,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
    }),
  );
  assert.strictEqual(recv.Messages?.length, 1, "Expected 1 message in queue");
  assert.strictEqual(recv.Messages![0].Body, "mixed-mode-message", "Message body mismatch");
  console.log("SQS message verified: OK");

  // ── Phase 5: Verify S3 object survived (via files) ──
  console.log("Verifying S3 object survived...");
  const obj = await s32.send(
    new GetObjectCommand({ Bucket: "mixed-bucket", Key: "mixed.txt" }),
  );
  const body = await obj.Body!.transformToString();
  assert.strictEqual(body, "Mixed mode data", "S3 body mismatch");
  assert.strictEqual(obj.ContentType, "text/plain", "S3 content-type mismatch");
  console.log("S3 object verified: OK");

  // Verify container 2 also logs both modes ON
  const logs2 = getLogs(`${MIXED_CONTAINER}-2`);
  assert.ok(
    logs2.includes("Persistence: ON"),
    `Expected "Persistence: ON" in container 2 logs.\nLogs:\n${logs2}`,
  );
  assert.ok(
    logs2.includes("S3 file storage: ON"),
    `Expected "S3 file storage: ON" in container 2 logs.\nLogs:\n${logs2}`,
  );
  console.log("Container 2 logs confirm both modes ON: OK");

  console.log("\nScenario 3 PASSED: Mixed mode — SQS via SQLite, S3 via files.");

  // Cleanup
  try { run(`docker rm -f ${MIXED_CONTAINER}-1`); } catch { /* ignore */ }
  try { run(`docker rm -f ${MIXED_CONTAINER}-2`); } catch { /* ignore */ }
  try { run(`docker volume rm ${MIXED_VOLUME_DATA}`); } catch { /* ignore */ }
  try { run(`docker volume rm ${MIXED_VOLUME_S3}`); } catch { /* ignore */ }
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 4: docker-compose with S3 file storage
// ──────────────────────────────────────────────────────────────────────────────

function compose(subcommand: string, env: Record<string, string> = {}): string {
  return runWithEnv(
    `docker compose -p ${COMPOSE_PROJECT} -f ${COMPOSE_FILE} ${subcommand}`,
    { FAUXQS_TEST_IMAGE: IMAGE, FAUXQS_TEST_PORT: String(HOST_PORT), ...env },
  );
}

function getComposeLogs(): string {
  try {
    return compose("logs fauxqs 2>&1");
  } catch {
    return "(could not retrieve compose logs)";
  }
}

async function pollHealthCompose(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  const url = `http://localhost:${port}/health`;
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`Health check returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("Compose logs:\n" + getComposeLogs());
  throw new Error(`Health check timed out after ${timeoutMs}ms (last error: ${lastError})`);
}

async function testComposeS3Storage(): Promise<void> {
  console.log("\n══════════════════════════════════════");
  console.log("  Scenario 4: docker-compose with S3 file storage");
  console.log("══════════════════════════════════════\n");

  // ── Phase 1: Start via docker compose ──
  console.log("Starting compose stack with S3 file storage...");
  compose("up -d");

  console.log("Waiting for health check...");
  await pollHealthCompose(HOST_PORT);
  console.log("Compose stack healthy.");

  // Verify S3 file storage is ON
  const logs = getComposeLogs();
  assert.ok(
    logs.includes("S3 file storage: ON"),
    `Expected "S3 file storage: ON" in compose logs.\nLogs:\n${logs}`,
  );
  console.log("S3 file storage status log: OK");

  const s3 = makeS3Client(HOST_PORT);

  // Create bucket and upload objects
  console.log("Creating S3 bucket and uploading objects...");
  await s3.send(new CreateBucketCommand({ Bucket: "compose-s3-bucket" }));
  await s3.send(
    new PutObjectCommand({
      Bucket: "compose-s3-bucket",
      Key: "compose.txt",
      Body: "Composed S3 storage",
      ContentType: "text/plain",
    }),
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: "compose-s3-bucket",
      Key: "docs/readme.md",
      Body: "# Nested key test",
      ContentType: "text/markdown",
    }),
  );

  // ── Phase 2: docker compose down (keeps volume) ──
  console.log("Stopping compose stack (docker compose down)...");
  compose("down");
  console.log("Compose stack stopped.");

  // ── Phase 3: docker compose up again ──
  console.log("Restarting compose stack...");
  compose("up -d");

  console.log("Waiting for health check...");
  await pollHealthCompose(HOST_PORT);
  console.log("Compose stack healthy after restart.");

  const s32 = makeS3Client(HOST_PORT);

  // ── Phase 4: Verify state survived ──
  console.log("Verifying S3 bucket survived...");
  const buckets = await s32.send(new ListBucketsCommand({}));
  assert.ok(
    buckets.Buckets?.some((b) => b.Name === "compose-s3-bucket"),
    "Expected compose-s3-bucket to exist after restart",
  );
  console.log("S3 bucket exists: OK");

  console.log("Verifying S3 objects survived...");
  const obj1 = await s32.send(
    new GetObjectCommand({ Bucket: "compose-s3-bucket", Key: "compose.txt" }),
  );
  assert.strictEqual(await obj1.Body!.transformToString(), "Composed S3 storage", "S3 body mismatch for compose.txt");
  console.log("S3 object compose.txt verified: OK");

  const obj2 = await s32.send(
    new GetObjectCommand({ Bucket: "compose-s3-bucket", Key: "docs/readme.md" }),
  );
  assert.strictEqual(await obj2.Body!.transformToString(), "# Nested key test", "S3 body mismatch for docs/readme.md");
  console.log("S3 object docs/readme.md verified: OK");

  const list = await s32.send(
    new ListObjectsV2Command({ Bucket: "compose-s3-bucket" }),
  );
  assert.strictEqual(list.KeyCount, 2, `Expected 2 objects, got ${list.KeyCount}`);
  console.log("S3 object count verified: OK");

  console.log("\nScenario 4 PASSED: docker-compose with S3 file storage persists state.");

  // Cleanup compose stack + volumes
  try { compose("down -v"); } catch { /* ignore */ }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  // Build image if not provided via env
  if (!process.env.FAUXQS_TEST_IMAGE) {
    console.log("Building Docker image...");
    run(`docker build -t ${IMAGE} .`);
  }

  await testS3StorageWithVolume();
  await testS3StorageWithoutVolume();
  await testMixedMode();
  await testComposeS3Storage();

  console.log("\n══════════════════════════════════════");
  console.log("  All S3 file storage acceptance tests passed!");
  console.log("══════════════════════════════════════\n");
}

main()
  .catch((err) => {
    console.error("\nS3 file storage acceptance test FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log("Cleaning up...");
    try { run(`docker rm -f ${CONTAINER_PREFIX}-1`); } catch { /* ignore */ }
    try { run(`docker rm -f ${CONTAINER_PREFIX}-2`); } catch { /* ignore */ }
    try { run(`docker rm -f ${NO_VOL_CONTAINER}`); } catch { /* ignore */ }
    try { run(`docker rm -f ${MIXED_CONTAINER}-1`); } catch { /* ignore */ }
    try { run(`docker rm -f ${MIXED_CONTAINER}-2`); } catch { /* ignore */ }
    try { run(`docker volume rm ${VOLUME_NAME}`); } catch { /* ignore */ }
    try { run(`docker volume rm ${MIXED_VOLUME_DATA}`); } catch { /* ignore */ }
    try { run(`docker volume rm ${MIXED_VOLUME_S3}`); } catch { /* ignore */ }
    try { compose("down -v"); } catch { /* ignore */ }
  });
