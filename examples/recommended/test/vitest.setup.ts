/**
 * Vitest setup file — runs in each test worker before test files.
 *
 * Unlike globalSetup (which runs in the main vitest process), setupFiles run
 * in the same process as the tests. This is critical for interceptLocalhostDns()
 * because the DNS patch must be active where the AWS SDK clients make HTTP calls.
 *
 * 1. Loads .env.test so tests use port 0 (random) instead of 4566 (Docker dev).
 * 2. Patches dns.lookup so *.localhost resolves to 127.0.0.1, enabling
 *    virtual-hosted-style S3 without forcePathStyle or external DNS.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { interceptLocalhostDns } from "fauxqs";
import { afterAll } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(resolve(__dirname, "../.env.test"));

const restore = interceptLocalhostDns();

afterAll(() => {
  restore();
});
