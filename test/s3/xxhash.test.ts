import { describe, it, expect } from "vitest";
import { xxh64, xxh3_64, xxh3_128 } from "../../src/s3/xxhash.js";
import { computeChecksum } from "../../src/s3/checksum.js";

/**
 * Reference vectors from the xxHash sanity check
 * (Cyan4973/xxHash v0.8.3, cli/xsum_sanity_check.c). The reference fills one
 * 2367-byte pseudorandom buffer and hashes prefixes of it, so the same PRNG is
 * reproduced here and every vector is taken over `sanityBuffer.subarray(0, len)`.
 */
const MASK64 = 0xffffffffffffffffn;
const PRIME32 = 2654435761n;
const PRIME64 = 11400714785074694797n;

function fillTestBuffer(len: number): Buffer {
  const buffer = Buffer.alloc(len);
  let byteGen = PRIME32;
  for (let i = 0; i < len; i++) {
    buffer[i] = Number(byteGen >> 56n);
    byteGen = (byteGen * PRIME64) & MASK64;
  }
  return buffer;
}

const sanityBuffer = fillTestBuffer(2367);
const prefix = (len: number) => sanityBuffer.subarray(0, len);

describe("xxHash reference vectors", () => {
  // [length, seed, expected]
  const xxh64Vectors: [number, bigint, bigint][] = [
    [0, 0n, 0xef46db3751d8e999n],
    [0, PRIME32, 0xac75fda2929b17efn],
    [1, 0n, 0xe934a84adb052768n],
    [1, PRIME32, 0x5014607643a9b4c3n],
    [4, 0n, 0x9136a0dca57457een],
    [14, 0n, 0x8282dcc4994e35c8n],
    [14, PRIME32, 0xc3bd6bf63deb6df0n],
    [222, 0n, 0xb641ae8cb691c174n],
    [222, PRIME32, 0x20cb8ab7ae10c14an],
  ];

  it.each(xxh64Vectors)("XXH64 of %i bytes with seed %s", (len, seed, expected) => {
    expect(xxh64(prefix(len), seed)).toBe(expected);
  });

  // Each entry targets a distinct branch of XXH3: the short-input special
  // cases, the mid-size paths, and the striped long path at block boundaries.
  const xxh3Vectors: [number, bigint][] = [
    [0, 0x2d06800538d394c2n],
    [1, 0xc44bdff4074eecdbn],
    [6, 0x27b56a84cd2d7325n],
    [12, 0xa713daf0dfbb77e7n],
    [24, 0xa3fe70bf9d3510ebn],
    [48, 0x397da259ecba1f11n],
    [80, 0xbcdefbbb2c47c90an],
    [195, 0xcd94217ee362ec3an],
    [403, 0xcdeb804d65c6dea4n],
    [512, 0x617e49599013cb6bn],
    [2048, 0xdd59e2c3a5f038e0n],
    [2099, 0xc6b9d9b3fc9ac765n],
    [2240, 0x6e73a90539cf2948n],
    [2367, 0xcb37aeb9e5d361edn],
  ];

  it.each(xxh3Vectors)("XXH3 (64-bit) of %i bytes", (len, expected) => {
    expect(xxh3_64(prefix(len))).toBe(expected);
  });

  // [length, low64, high64]
  const xxh128Vectors: [number, bigint, bigint][] = [
    [0, 0x6001c324468d497fn, 0x99aa06d3014798d8n],
    [1, 0xc44bdff4074eecdbn, 0xa6cd5e9392000f6an],
    [6, 0x3e7039bdda43cfc6n, 0x082afe0b8162d12an],
    [12, 0x061a192713f69ad9n, 0x6e3efd8fc7802b18n],
    [24, 0x1e7044d28b1b901dn, 0x0ce966e4678d3761n],
    [48, 0xf942219aed80f67bn, 0xa002ac4e5478227en],
    [81, 0x5e8bafb9f95fb803n, 0x4952f58181ab0042n],
    [222, 0xf1aebd597cec6b3an, 0x337e09641b948717n],
    [403, 0xcdeb804d65c6dea4n, 0x1b6de21e332dd73dn],
    [512, 0x617e49599013cb6bn, 0x18d2d110dcc9bca1n],
    [2048, 0xdd59e2c3a5f038e0n, 0xf736557fd47073a5n],
    [2240, 0x6e73a90539cf2948n, 0xccb134fbfa7ce49dn],
    [2367, 0xcb37aeb9e5d361edn, 0xe89c0f6ff369b427n],
  ];

  it.each(xxh128Vectors)("XXH3 (128-bit) of %i bytes", (len, low, high) => {
    expect(xxh3_128(prefix(len))).toEqual({ low, high });
  });
});

describe("computeChecksum encoding", () => {
  it("encodes XXHASH64 and XXHASH3 as 8 big-endian bytes", () => {
    const data = prefix(403);
    expect(Buffer.from(computeChecksum("XXHASH64", data), "base64")).toEqual(
      bigintToBuffer(xxh64(data), 8),
    );
    expect(Buffer.from(computeChecksum("XXHASH3", data), "base64")).toEqual(
      bigintToBuffer(xxh3_64(data), 8),
    );
  });

  it("encodes XXHASH128 as 16 big-endian bytes, high half first", () => {
    const data = prefix(403);
    const { high, low } = xxh3_128(data);
    expect(Buffer.from(computeChecksum("XXHASH128", data), "base64")).toEqual(
      Buffer.concat([bigintToBuffer(high, 8), bigintToBuffer(low, 8)]),
    );
  });

  it("produces the documented digest sizes for every algorithm", () => {
    const sizes: Record<string, number> = {
      CRC32: 4,
      CRC32C: 4,
      CRC64NVME: 8,
      SHA1: 20,
      SHA256: 32,
      SHA512: 64,
      MD5: 16,
      XXHASH64: 8,
      XXHASH3: 8,
      XXHASH128: 16,
    };
    for (const [algorithm, size] of Object.entries(sizes)) {
      const value = computeChecksum(algorithm as keyof typeof sizes, Buffer.from("abc"));
      expect(Buffer.from(value, "base64"), algorithm).toHaveLength(size);
    }
  });
});

function bigintToBuffer(value: bigint, bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  buf.writeBigUInt64BE(value);
  return buf;
}
