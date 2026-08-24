import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import { S3Error } from "../common/errors.ts";
import { CHECKSUM_ALGORITHMS, type ChecksumAlgorithm } from "./s3Types.ts";
import { xxh3_64, xxh3_128, xxh64 } from "./xxhash.ts";

/**
 * Compute CRC32 (IEEE) of a buffer, returning a uint32.
 * Uses zlib.crc32 (Node 22.2+) when available, otherwise falls back to a lookup table.
 */
let crc32: (data: Buffer) => number;

if (typeof (zlib as any).crc32 === "function") {
  crc32 = (data: Buffer) => (zlib as any).crc32(data) >>> 0;
} else {
  // IEEE CRC32 lookup table
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crc32 = (data: Buffer) => {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
}

export { crc32 };

/**
 * CRC32C (Castagnoli) lookup table. Reflected polynomial 0x82F63B78.
 * This is the checksum algorithm AWS S3 exposes as `x-amz-checksum-crc32c`.
 */
const crc32cTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
  }
  crc32cTable[i] = c >>> 0;
}

/** Compute CRC32C (Castagnoli) of a buffer, returning a uint32. */
export function crc32c(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crc32cTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * CRC-64/NVME lookup table. Reflected polynomial 0x9A6C9329AC4BC9B5
 * (reverse of the normal polynomial 0xAD93D23594C935A9).
 * This is the checksum algorithm AWS S3 exposes as `x-amz-checksum-crc64nvme`.
 * It is the default for the AWS CLI v2 and CRT-based SDKs; the
 * `@aws-sdk/client-s3` JavaScript SDK still defaults to CRC32.
 */
const CRC64NVME_POLY = 0x9a6c9329ac4bc9b5n;

// CRC-64/NVME lookup table, split into high/low 32-bit halves. Keeping the
// table (and the running CRC) as pairs of 32-bit integers lets the hot path
// use fast integer math instead of a per-byte BigInt operation, which is
// roughly an order of magnitude slower for large object bodies.
const crc64TableHi = new Uint32Array(256);
const crc64TableLo = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = BigInt(i);
  for (let j = 0; j < 8; j++) {
    crc = crc & 1n ? (crc >> 1n) ^ CRC64NVME_POLY : crc >> 1n;
  }
  crc64TableHi[i] = Number(crc >> 32n);
  crc64TableLo[i] = Number(crc & 0xffffffffn);
}

/**
 * Compute CRC-64/NVME of a buffer, returning a uint64 as a bigint.
 * The 64-bit running CRC is kept as two 32-bit halves so the per-byte loop
 * runs entirely on fast integer math; BigInt is touched only to assemble the
 * final result.
 */
export function crc64nvme(data: Buffer): bigint {
  let hi = 0xffffffff;
  let lo = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const idx = (lo ^ data[i]) & 0xff;
    // crc >>>= 8, carrying the low byte of `hi` into the high byte of `lo`
    const shiftedLo = ((lo >>> 8) | (hi << 24)) >>> 0;
    const shiftedHi = hi >>> 8;
    lo = (shiftedLo ^ crc64TableLo[idx]) >>> 0;
    hi = (shiftedHi ^ crc64TableHi[idx]) >>> 0;
  }
  hi = (hi ^ 0xffffffff) >>> 0;
  lo = (lo ^ 0xffffffff) >>> 0;
  return (BigInt(hi) << 32n) | BigInt(lo);
}

/** Return the request/response header name for a checksum algorithm. */
export function checksumHeaderName(algorithm: ChecksumAlgorithm): string {
  return `x-amz-checksum-${algorithm.toLowerCase()}`;
}

/** The algorithms Node's `crypto` covers directly. */
const NODE_HASH_NAMES: Record<"SHA1" | "SHA256" | "SHA512" | "MD5", string> = {
  SHA1: "sha1",
  SHA256: "sha256",
  SHA512: "sha512",
  MD5: "md5",
};

/** Compute a base64-encoded checksum of data. */
export function computeChecksum(algorithm: ChecksumAlgorithm, data: Buffer): string {
  switch (algorithm) {
    case "CRC32":
    case "CRC32C": {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(algorithm === "CRC32" ? crc32(data) : crc32c(data));
      return buf.toString("base64");
    }
    case "CRC64NVME": {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64BE(crc64nvme(data));
      return buf.toString("base64");
    }
    case "XXHASH64":
    case "XXHASH3": {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64BE(algorithm === "XXHASH64" ? xxh64(data) : xxh3_64(data));
      return buf.toString("base64");
    }
    case "XXHASH128": {
      const { high, low } = xxh3_128(data);
      const buf = Buffer.alloc(16);
      buf.writeBigUInt64BE(high, 0);
      buf.writeBigUInt64BE(low, 8);
      return buf.toString("base64");
    }
    case "SHA1":
    case "SHA256":
    case "SHA512":
    case "MD5":
      return createHash(NODE_HASH_NAMES[algorithm]).update(data).digest("base64");
    default: {
      // Exhaustiveness guard: adding an algorithm to CHECKSUM_ALGORITHMS
      // without handling it here is a compile error, not a runtime 500.
      const unhandled: never = algorithm;
      throw new Error(`Unsupported checksum algorithm: ${String(unhandled)}`);
    }
  }
}

/**
 * Verify a client-supplied checksum against the body it describes, the way real
 * S3 does. Skippable via the `disableChecksumValidation` relaxed rule, since
 * storing checksums as-is lets a corrupt upload pass locally and fail in
 * production.
 */
export function validateChecksum(algorithm: ChecksumAlgorithm, value: string, data: Buffer): void {
  if (computeChecksum(algorithm, data) === value) {
    return;
  }
  throw new S3Error(
    "BadDigest",
    `The ${algorithm} you specified did not match the calculated checksum.`,
    400,
  );
}

/**
 * Verify the legacy `Content-MD5` header, which predates the flexible checksum
 * headers and is unrelated to `x-amz-checksum-md5`. Real S3 rejects a mismatch
 * on every request that carries it.
 */
export function validateContentMd5(
  headers: Record<string, string | string[] | undefined>,
  data: Buffer,
): void {
  const raw = headers["content-md5"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return;
  }
  if (Buffer.from(value, "base64").length !== 16) {
    throw new S3Error("InvalidDigest", `The Content-MD5 you specified is not valid.`, 400);
  }
  if (createHash("md5").update(data).digest("base64") !== value) {
    throw new S3Error(
      "BadDigest",
      "The Content-MD5 you specified did not match what we received.",
      400,
    );
  }
}

/** Compute composite checksum for multipart uploads. */
export function computeCompositeChecksum(
  algorithm: ChecksumAlgorithm,
  partChecksums: string[],
): string {
  // Decode each part checksum, concatenate raw bytes, hash the concatenation
  const raw = Buffer.concat(partChecksums.map((c) => Buffer.from(c, "base64")));
  const hash = computeChecksum(algorithm, raw);
  return `${hash}-${partChecksums.length}`;
}

/**
 * Order in which `x-amz-checksum-*` headers are read when a request carries
 * exactly one. Declared as a total map so adding an algorithm to
 * CHECKSUM_ALGORITHMS is a compile error until it is placed here; the header
 * names themselves are derived, never restated.
 */
const CHECKSUM_HEADER_PRIORITY: Record<ChecksumAlgorithm, number> = {
  CRC64NVME: 0,
  CRC32: 1,
  CRC32C: 2,
  SHA1: 3,
  SHA256: 4,
  SHA512: 5,
  // Note: this is `x-amz-checksum-md5`, the flexible-checksum header added in
  // 2026 — not the legacy `Content-MD5` header, which is unrelated.
  MD5: 6,
  XXHASH64: 7,
  XXHASH3: 8,
  XXHASH128: 9,
};

const CHECKSUM_HEADERS: { header: string; algorithm: ChecksumAlgorithm }[] = [
  ...CHECKSUM_ALGORITHMS,
]
  .sort((a, b) => CHECKSUM_HEADER_PRIORITY[a] - CHECKSUM_HEADER_PRIORITY[b])
  .map((algorithm) => ({ header: checksumHeaderName(algorithm), algorithm }));

const CHECKSUM_ALGORITHM_NAMES = new Set<string>(CHECKSUM_ALGORITHMS);

/** Narrow an `x-amz-checksum-algorithm` header value to a supported algorithm. */
export function isChecksumAlgorithm(value: string): value is ChecksumAlgorithm {
  return CHECKSUM_ALGORITHM_NAMES.has(value);
}

/**
 * Read `x-amz-checksum-algorithm`: the client naming an algorithm for S3 to
 * compute itself, rather than supplying a precomputed value.
 */
export function requestedChecksumAlgorithm(
  headers: Record<string, string | string[] | undefined>,
): ChecksumAlgorithm | undefined {
  const raw = headers["x-amz-checksum-algorithm"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.toUpperCase();
  return value && isChecksumAlgorithm(value) ? value : undefined;
}

/**
 * Extract checksum algorithm+value from request headers or trailing headers.
 * Real S3 accepts at most one, so a request naming two is rejected rather than
 * having the loser silently dropped.
 */
export function extractChecksumFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): { algorithm: ChecksumAlgorithm; value: string } | undefined {
  let found: { algorithm: ChecksumAlgorithm; value: string } | undefined;
  for (const { header, algorithm } of CHECKSUM_HEADERS) {
    const v = headers[header];
    if (!v) {
      continue;
    }
    if (found) {
      throw new S3Error(
        "InvalidRequest",
        "Expecting a single x-amz-checksum- header. Multiple checksum Types are not allowed.",
        400,
      );
    }
    found = { algorithm, value: Array.isArray(v) ? v[0] : v };
  }
  return found;
}

/**
 * Resolve the checksum to record for an uploaded body: the value the client
 * supplied if there is one, otherwise a value computed here when the client
 * only named an algorithm. Real S3 does both; fauxqs used to do neither for the
 * algorithm-only case, leaving those objects with no checksum at all.
 */
export function resolveUploadChecksum(
  headers: Record<string, string | string[] | undefined>,
  trailers: Record<string, string> | undefined,
  body: Buffer,
  validate: boolean,
): { algorithm: ChecksumAlgorithm; value: string } | undefined {
  const supplied =
    (trailers && extractChecksumFromHeaders(trailers)) ?? extractChecksumFromHeaders(headers);
  if (supplied) {
    if (validate) {
      validateChecksum(supplied.algorithm, supplied.value, body);
    }
    return supplied;
  }
  const requested = requestedChecksumAlgorithm(headers);
  return requested ? { algorithm: requested, value: computeChecksum(requested, body) } : undefined;
}

/**
 * Narrow a persisted algorithm name back to a supported algorithm, dropping
 * anything the current build no longer recognizes. Trusting the stored string
 * blindly would let a stale or hand-edited record reach computeChecksum.
 */
export function toChecksumAlgorithm(
  value: string | null | undefined,
): ChecksumAlgorithm | undefined {
  return value != null && isChecksumAlgorithm(value) ? value : undefined;
}
