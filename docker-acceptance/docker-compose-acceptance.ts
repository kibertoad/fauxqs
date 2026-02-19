import assert from "node:assert";
import { execSync } from "node:child_process";
import {
  SQSClient,
  ReceiveMessageCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";

const COMPOSE_FILE = "docker-acceptance/docker-compose.test.yml";
const HOST_PORT = 14566;
const QUEUE_NAME = "acceptance-results";

function run(cmd: string): string {
  console.log(`> ${cmd}`);
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function runPassthrough(cmd: string): void {
  console.log(`> ${cmd}`);
  execSync(cmd, { encoding: "utf-8", stdio: "inherit" });
}

async function pollHealth(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
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
    const logs = run(
      `docker compose -f ${COMPOSE_FILE} logs fauxqs`,
    );
    console.error("fauxqs logs:\n" + logs);
  } catch {
    /* compose may be gone */
  }
  throw new Error(
    `Health check timed out after ${timeoutMs}ms (last error: ${lastError})`,
  );
}

async function main() {
  // Build and start fauxqs
  console.log("Building and starting compose stack...");
  runPassthrough(
    `docker compose -f ${COMPOSE_FILE} build`,
  );
  runPassthrough(
    `docker compose -f ${COMPOSE_FILE} up -d fauxqs`,
  );

  console.log("Waiting for fauxqs health check...");
  await pollHealth();
  console.log("fauxqs is healthy.");

  // Run the test-app container
  console.log("\nRunning test-app container...");
  runPassthrough(
    `docker compose -f ${COMPOSE_FILE} run --rm test-app`,
  );
  console.log("test-app exited successfully.");

  // From host: verify PASS message via SQS
  console.log("\nVerifying SQS message from host...");
  const sqs = new SQSClient({
    endpoint: `http://localhost:${HOST_PORT}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: QUEUE_NAME }),
  );

  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
    }),
  );

  assert.ok(Messages && Messages.length > 0, "No messages received from SQS");
  assert.strictEqual(Messages[0].Body, "PASS", `Expected PASS, got: ${Messages[0].Body}`);
  console.log("SQS message verified: PASS");

  console.log("\nAll compose acceptance tests passed!");
}

main()
  .catch((err) => {
    console.error("\nCompose acceptance test FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log("\nCleaning up compose stack...");
    try {
      run(`docker compose -f ${COMPOSE_FILE} down --volumes --remove-orphans`);
    } catch {
      // compose may not be running
    }
  });
