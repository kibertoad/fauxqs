import assert from "node:assert";
import { execSync } from "node:child_process";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";

const IMAGE = process.env.FAUXQS_TEST_IMAGE ?? "fauxqs-persistence-test";
const VOLUME_NAME = `fauxqs-persist-test-${Date.now()}`;
const CONTAINER_PREFIX = `fauxqs-persist-${Date.now()}`;
const NO_VOL_CONTAINER = `fauxqs-novol-${Date.now()}`;
const HOST_PORT = 14567;

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
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

function makeSqsClient(port: number): SQSClient {
  return new SQSClient({
    endpoint: `http://localhost:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

function makeS3Client(port: number): S3Client {
  return new S3Client({
    endpoint: `http://localhost:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
  });
}

async function testWithVolume(): Promise<void> {
  console.log("\n══════════════════════════════════════");
  console.log("  Scenario 1: WITH volume (persistence enabled)");
  console.log("══════════════════════════════════════\n");

  // Create named volume
  console.log(`Creating volume: ${VOLUME_NAME}`);
  run(`docker volume create ${VOLUME_NAME}`);

  // ── Phase 1: Start container, create state ──
  console.log("Starting container 1...");
  run(
    `docker run -d --name ${CONTAINER_PREFIX}-1 -p ${HOST_PORT}:4566 -v ${VOLUME_NAME}:/data ${IMAGE}`,
  );

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, `${CONTAINER_PREFIX}-1`);
  console.log("Container 1 healthy.");

  const sqs = makeSqsClient(HOST_PORT);
  const s3 = makeS3Client(HOST_PORT);

  // Create SQS queue and send message
  console.log("Creating SQS queue and sending message...");
  const createQueueResult = await sqs.send(new CreateQueueCommand({ QueueName: "persist-q" }));
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: createQueueResult.QueueUrl!,
      MessageBody: "survive-restart",
    }),
  );

  // Create S3 bucket and upload object
  console.log("Creating S3 bucket and uploading object...");
  await s3.send(new CreateBucketCommand({ Bucket: "persist-bucket" }));
  await s3.send(
    new PutObjectCommand({
      Bucket: "persist-bucket",
      Key: "test.txt",
      Body: "Hello from Docker persistence test!",
      ContentType: "text/plain",
    }),
  );

  // ── Phase 2: Stop container gracefully ──
  console.log("Stopping container 1 (graceful shutdown)...");
  run(`docker stop ${CONTAINER_PREFIX}-1`);
  console.log("Container 1 stopped.");

  // ── Phase 3: Start NEW container with same volume ──
  console.log("Starting container 2 with same volume...");
  run(
    `docker run -d --name ${CONTAINER_PREFIX}-2 -p ${HOST_PORT}:4566 -v ${VOLUME_NAME}:/data ${IMAGE}`,
  );

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, `${CONTAINER_PREFIX}-2`);
  console.log("Container 2 healthy.");

  const sqs2 = makeSqsClient(HOST_PORT);
  const s32 = makeS3Client(HOST_PORT);

  // ── Phase 4: Verify state survived ──
  console.log("Verifying SQS message...");
  const recv = await sqs2.send(
    new ReceiveMessageCommand({
      QueueUrl: `http://sqs.us-east-1.localhost:${HOST_PORT}/000000000000/persist-q`,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
    }),
  );
  assert.strictEqual(recv.Messages?.length, 1, "Expected 1 message in queue");
  assert.strictEqual(recv.Messages![0].Body, "survive-restart", "Message body mismatch");
  console.log("SQS message verified: OK");

  console.log("Verifying S3 bucket...");
  const buckets = await s32.send(new ListBucketsCommand({}));
  assert.ok(
    buckets.Buckets?.some((b) => b.Name === "persist-bucket"),
    "Expected persist-bucket to exist",
  );
  console.log("S3 bucket exists: OK");

  console.log("Verifying S3 object...");
  const obj = await s32.send(
    new GetObjectCommand({ Bucket: "persist-bucket", Key: "test.txt" }),
  );
  const body = await obj.Body!.transformToString();
  assert.strictEqual(body, "Hello from Docker persistence test!", "S3 body mismatch");
  assert.strictEqual(obj.ContentType, "text/plain", "S3 content-type mismatch");
  console.log("S3 object verified: OK");

  console.log("\nScenario 1 PASSED: state survived restart with volume.");

  // Cleanup volume-test containers so port is free for next scenario
  try { run(`docker rm -f ${CONTAINER_PREFIX}-1`); } catch { /* ignore */ }
  try { run(`docker rm -f ${CONTAINER_PREFIX}-2`); } catch { /* ignore */ }
  try { run(`docker volume rm ${VOLUME_NAME}`); } catch { /* ignore */ }
}

async function testWithoutVolume(): Promise<void> {
  console.log("\n══════════════════════════════════════");
  console.log("  Scenario 2: WITHOUT volume (persistence disabled)");
  console.log("══════════════════════════════════════\n");

  // ── Phase 1: Start container WITHOUT -v flag ──
  console.log("Starting container without volume...");
  run(
    `docker run -d --name ${NO_VOL_CONTAINER} -p ${HOST_PORT}:4566 ${IMAGE}`,
  );

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, NO_VOL_CONTAINER);
  console.log("Container healthy.");

  // Verify entrypoint detected missing volume
  const logs = getLogs(NO_VOL_CONTAINER);
  assert.ok(
    logs.includes("No volume mounted at /data"),
    `Expected "No volume mounted at /data" in container logs.\nLogs:\n${logs}`,
  );
  console.log("Mountpoint detection log message: OK");

  const sqs = makeSqsClient(HOST_PORT);
  const s3 = makeS3Client(HOST_PORT);

  // ── Phase 2: Create state ──
  console.log("Creating SQS queue and sending message...");
  const createQueueResult = await sqs.send(new CreateQueueCommand({ QueueName: "novol-q" }));
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: createQueueResult.QueueUrl!,
      MessageBody: "should-not-persist",
    }),
  );

  console.log("Creating S3 bucket and uploading object...");
  await s3.send(new CreateBucketCommand({ Bucket: "novol-bucket" }));
  await s3.send(
    new PutObjectCommand({
      Bucket: "novol-bucket",
      Key: "ephemeral.txt",
      Body: "This should vanish",
      ContentType: "text/plain",
    }),
  );

  // ── Phase 3: docker stop + docker start (same container, preserves writable layer) ──
  console.log("Stopping container (docker stop)...");
  run(`docker stop ${NO_VOL_CONTAINER}`);
  console.log("Container stopped.");

  console.log("Restarting same container (docker start)...");
  run(`docker start ${NO_VOL_CONTAINER}`);

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, NO_VOL_CONTAINER);
  console.log("Container healthy after restart.");

  // Verify mountpoint detection fires again on restart
  const logsAfterRestart = getLogs(NO_VOL_CONTAINER);
  const occurrences = logsAfterRestart.split("No volume mounted at /data").length - 1;
  assert.ok(
    occurrences >= 2,
    `Expected "No volume mounted at /data" to appear at least twice (once per start). Found ${occurrences} time(s).\nLogs:\n${logsAfterRestart}`,
  );
  console.log("Mountpoint detection on restart: OK");

  // ── Phase 4: Verify state is GONE ──
  const sqs2 = makeSqsClient(HOST_PORT);
  const s32 = makeS3Client(HOST_PORT);

  console.log("Verifying SQS state is gone...");
  // Queue should not exist — ReceiveMessage on a non-existent queue will throw,
  // or if the server started fresh the queue simply isn't there.
  try {
    const recv = await sqs2.send(
      new ReceiveMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${HOST_PORT}/000000000000/novol-q`,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 0,
      }),
    );
    // If we get here, the queue exists but should be empty
    assert.strictEqual(
      recv.Messages?.length ?? 0,
      0,
      "Expected no messages in queue after restart without volume",
    );
    console.log("SQS: queue exists but empty (no persistence): OK");
  } catch (err: any) {
    // Queue doesn't exist — that's the expected outcome
    assert.ok(
      err.name === "QueueDoesNotExist" || err.name === "AWS.SimpleQueueService.NonExistentQueue",
      `Unexpected error: ${err.name}: ${err.message}`,
    );
    console.log("SQS: queue does not exist (no persistence): OK");
  }

  console.log("Verifying S3 state is gone...");
  const buckets = await s32.send(new ListBucketsCommand({}));
  assert.strictEqual(
    buckets.Buckets?.length ?? 0,
    0,
    `Expected no buckets after restart without volume, got: ${buckets.Buckets?.map((b) => b.Name).join(", ")}`,
  );
  console.log("S3: no buckets (no persistence): OK");

  console.log("\nScenario 2 PASSED: state did NOT survive restart without volume.");
}

async function main() {
  // Build image if not provided via env
  if (!process.env.FAUXQS_TEST_IMAGE) {
    console.log("Building Docker image...");
    run(`docker build -t ${IMAGE} .`);
  }

  await testWithVolume();
  await testWithoutVolume();

  console.log("\n══════════════════════════════════════");
  console.log("  All persistence acceptance tests passed!");
  console.log("══════════════════════════════════════\n");
}

main()
  .catch((err) => {
    console.error("\nPersistence acceptance test FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log("Cleaning up...");
    try { run(`docker rm -f ${CONTAINER_PREFIX}-1`); } catch { /* ignore */ }
    try { run(`docker rm -f ${CONTAINER_PREFIX}-2`); } catch { /* ignore */ }
    try { run(`docker rm -f ${NO_VOL_CONTAINER}`); } catch { /* ignore */ }
    try { run(`docker volume rm ${VOLUME_NAME}`); } catch { /* ignore */ }
  });
