import { execSync } from "node:child_process";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";

/**
 * Helpers shared by the Docker acceptance suites. They all drive real
 * containers, so keep them dependency-free and side-effect-free at import time.
 */

export function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export function runWithEnv(cmd: string, env: Record<string, string>): string {
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
}

export function getLogs(containerName: string): string {
  try {
    return run(`docker logs ${containerName} 2>&1`);
  } catch {
    return "(could not retrieve logs)";
  }
}

/** Waits for /health to answer 200, dumping the container's logs on timeout. */
export async function pollHealth(
  port: number,
  containerName: string,
  timeoutMs = 30_000,
): Promise<void> {
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

export function makeSqsClient(port: number): SQSClient {
  return new SQSClient({
    endpoint: `http://localhost:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

export function makeS3Client(port: number): S3Client {
  return new S3Client({
    endpoint: `http://localhost:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
  });
}
