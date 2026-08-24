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

const NODE_HASH_NAMES: Partial<Record<ChecksumAlgorithm, string>> = {
  SHA1: "sha1",
  SHA256: "sha256",
  SHA512: "sha512",
  MD5: "md5",
};

/** Compute a base64-encoded checksum of data. */
export function computeChecksum(algorithm: ChecksumAlgorithm, data: Buffer): string {
  if (algorithm === "CRC32") {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(crc32(data));
    return buf.toString("base64");
  }
  if (algorithm === "CRC32C") {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(crc32c(data));
    return buf.toString("base64");
  }
  if (algorithm === "CRC64NVME") {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(crc64nvme(data));
    return buf.toString("base64");
  }
  if (algorithm === "XXHASH64" || algorithm === "XXHASH3") {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(algorithm === "XXHASH64" ? xxh64(data) : xxh3_64(data));
    return buf.toString("base64");
  }
  if (algorithm === "XXHASH128") {
    const { high, low } = xxh3_128(data);
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64BE(high, 0);
    buf.writeBigUInt64BE(low, 8);
    return buf.toString("base64");
  }
  return createHash(NODE_HASH_NAMES[algorithm]!).update(data).digest("base64");
}

/**
 * Verify a client-supplied checksum against the body it describes, the way real
 * S3 does. Opt-in via the `validateChecksums` strict rule: fauxqs otherwise
 * stores checksums as-is, which lets a corrupt upload pass locally and fail in
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

const CHECKSUM_HEADERS: { header: string; algorithm: ChecksumAlgorithm }[] = [
  { header: "x-amz-checksum-crc64nvme", algorithm: "CRC64NVME" },
  { header: "x-amz-checksum-crc32", algorithm: "CRC32" },
  { header: "x-amz-checksum-crc32c", algorithm: "CRC32C" },
  { header: "x-amz-checksum-sha1", algorithm: "SHA1" },
  { header: "x-amz-checksum-sha256", algorithm: "SHA256" },
  { header: "x-amz-checksum-sha512", algorithm: "SHA512" },
  // Note: this is `x-amz-checksum-md5`, the flexible-checksum header added in
  // 2026 — not the legacy `Content-MD5` header, which is unrelated.
  { header: "x-amz-checksum-md5", algorithm: "MD5" },
  { header: "x-amz-checksum-xxhash64", algorithm: "XXHASH64" },
  { header: "x-amz-checksum-xxhash3", algorithm: "XXHASH3" },
  { header: "x-amz-checksum-xxhash128", algorithm: "XXHASH128" },
];

const CHECKSUM_ALGORITHM_NAMES = new Set<string>(CHECKSUM_ALGORITHMS);

/** Narrow an `x-amz-checksum-algorithm` header value to a supported algorithm. */
export function isChecksumAlgorithm(value: string): value is ChecksumAlgorithm {
  return CHECKSUM_ALGORITHM_NAMES.has(value);
}

/** Extract checksum algorithm+value from request headers or trailing headers. */
export function extractChecksumFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): { algorithm: ChecksumAlgorithm; value: string } | undefined {
  for (const { header, algorithm } of CHECKSUM_HEADERS) {
    const v = headers[header];
    if (v) {
      return { algorithm, value: Array.isArray(v) ? v[0] : v };
    }
  }
  return undefined;
}

/** Return the response header name for a checksum algorithm. */
export function checksumHeaderName(algorithm: ChecksumAlgorithm): string {
  return `x-amz-checksum-${algorithm.toLowerCase()}`;
}
