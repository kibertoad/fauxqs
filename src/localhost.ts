import http from "node:http";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const LOCALHOST_RESULT: dns.LookupAddress = { address: "127.0.0.1", family: 4 };

/**
 * Creates a pre-configured HTTP request handler that resolves all hostnames
 * to 127.0.0.1. This enables virtual-hosted-style S3 requests (bucket name
 * in Host header) without requiring wildcard DNS or external services.
 *
 * Scoped to a single client instance — no global side effects.
 *
 * ```typescript
 * import { createLocalhostHandler } from "fauxqs";
 *
 * const s3 = new S3Client({
 *   endpoint: `http://s3.localhost:${port}`,
 *   requestHandler: createLocalhostHandler(),
 * });
 * ```
 */
export function createLocalhostHandler(): NodeHttpHandler {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [LOCALHOST_RESULT]);
    } else {
      callback(null, LOCALHOST_RESULT.address, LOCALHOST_RESULT.family);
    }
  };

  return new NodeHttpHandler({ httpAgent: new http.Agent({ lookup }) });
}

/**
 * Patches the global `dns.lookup` to resolve any hostname ending with the
 * given suffix to 127.0.0.1. Returns a function that restores the original
 * `dns.lookup`.
 *
 * This makes virtual-hosted-style S3 requests work transparently — no client
 * configuration changes needed. However, it affects all DNS lookups in the
 * process, so it is best used in test suites (e.g., `beforeAll` / `afterAll`).
 *
 * @param hostname - Suffix to match (default: `"localhost"`). Any hostname
 *   ending with `.${hostname}` will be resolved to 127.0.0.1.
 *
 * ```typescript
 * import { interceptLocalhostDns } from "fauxqs";
 *
 * const restore = interceptLocalhostDns();
 * // S3 client works without forcePathStyle or custom requestHandler
 * restore();
 * ```
 */
export function interceptLocalhostDns(hostname = "localhost"): () => void {
  const suffix = `.${hostname}`;
  const original = dns.lookup;

  const patched: LookupFunction = (name, options, callback) => {
    if (name.endsWith(suffix)) {
      if (options.all) {
        callback(null, [LOCALHOST_RESULT]);
      } else {
        callback(null, LOCALHOST_RESULT.address, LOCALHOST_RESULT.family);
      }
      return;
    }
    original(name, options, callback);
  };

  dns.lookup = patched as typeof dns.lookup;

  return () => {
    dns.lookup = original;
  };
}
