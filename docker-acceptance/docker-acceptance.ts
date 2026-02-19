import assert from "node:assert";
import { execSync } from "node:child_process";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const CONTAINER_NAME = `fauxqs-acceptance-${Date.now()}`;
const HOST_PORT = 14566;
const ENDPOINT = `http://s3.localhost.fauxqs.dev:${HOST_PORT}`;
const BUCKET = "test-bucket";
const KEY = "hello.txt";
const BODY = "Hello from Docker acceptance test!";

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function pollHealth(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  // Use plain localhost for health check — no wildcard DNS dependency
  const url = `http://localhost:${HOST_PORT}/health`;
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
  // Dump container logs for debugging
  try {
    const logs = run(`docker logs ${CONTAINER_NAME}`);
    console.error("Container logs:\n" + logs);
  } catch { /* container may be gone */ }
  throw new Error(`Health check timed out after ${timeoutMs}ms (last error: ${lastError})`);
}

async function main() {
  console.log("Building Docker image...");
  run("docker build -t fauxqs-acceptance-test .");

  console.log("Starting container...");
  run(
    `docker run -d --name ${CONTAINER_NAME} -p ${HOST_PORT}:4566 fauxqs-acceptance-test`,
  );

  console.log("Waiting for health check...");
  await pollHealth();
  console.log("Server is healthy.");

  // S3 client with virtual-hosted-style (no forcePathStyle)
  const s3 = new S3Client({
    endpoint: ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  // Create bucket
  console.log(`Creating bucket: ${BUCKET}`);
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));

  // Upload object via SDK
  console.log(`Uploading object: ${KEY}`);
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: KEY,
      Body: BODY,
      ContentType: "text/plain",
    }),
  );

  // Download via SDK GetObject
  console.log("Downloading via SDK GetObject...");
  const getResult = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: KEY }),
  );
  const sdkBody = await getResult.Body!.transformToString();
  assert.strictEqual(sdkBody, BODY, "SDK GetObject body mismatch");
  console.log("SDK GetObject: OK");

  // Download via raw fetch (virtual-hosted-style URL)
  const fetchUrl = `http://${BUCKET}.s3.localhost.fauxqs.dev:${HOST_PORT}/${KEY}`;
  console.log(`Downloading via fetch: ${fetchUrl}`);
  const fetchRes = await fetch(fetchUrl);
  assert.strictEqual(fetchRes.status, 200, `fetch status: ${fetchRes.status}`);
  const fetchBody = await fetchRes.text();
  assert.strictEqual(fetchBody, BODY, "fetch body mismatch");
  console.log("Raw fetch: OK");

  console.log("\nAll acceptance tests passed!");
}

main()
  .catch((err) => {
    console.error("\nAcceptance test FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log("Cleaning up container...");
    try {
      run(`docker rm -f ${CONTAINER_NAME}`);
    } catch {
      // container may not exist
    }
  });
