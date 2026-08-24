import assert from "node:assert";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { pollHealth, run } from "./dockerTestUtils.ts";

const CONTAINER_NAME = `fauxqs-acceptance-${Date.now()}`;
const HOST_PORT = 14566;
const ENDPOINT = `http://s3.localhost.fauxqs.dev:${HOST_PORT}`;
const BUCKET = "test-bucket";
const KEY = "hello.txt";
const BODY = "Hello from Docker acceptance test!";

async function main() {
  console.log("Building Docker image...");
  run("docker build -t fauxqs-acceptance-test .");

  console.log("Starting container...");
  run(
    `docker run -d --name ${CONTAINER_NAME} -p ${HOST_PORT}:4566 fauxqs-acceptance-test`,
  );

  console.log("Waiting for health check...");
  await pollHealth(HOST_PORT, CONTAINER_NAME);
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
