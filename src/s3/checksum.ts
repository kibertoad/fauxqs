import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import type { ChecksumAlgorithm } from "./s3Types.ts";

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
const MASK64 = 0xffffffffffffffffn;
const crc64Table: bigint[] = Array.from({ length: 256 }, (_, i) => {
  let crc = BigInt(i);
  for (let j = 0; j < 8; j++) {
    crc = crc & 1n ? (crc >> 1n) ^ CRC64NVME_POLY : crc >> 1n;
  }
  return crc;
});

/** Compute CRC-64/NVME of a buffer, returning a uint64 as a bigint. */
export function crc64nvme(data: Buffer): bigint {
  let crc = MASK64;
  for (let i = 0; i < data.length; i++) {
    crc = crc64Table[Number((crc ^ BigInt(data[i])) & 0xffn)] ^ (crc >> 8n);
  }
  return crc ^ MASK64;
}

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
  const hashName = algorithm === "SHA1" ? "sha1" : "sha256";
  return createHash(hashName).update(data).digest("base64");
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
];

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
