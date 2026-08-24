/**
 * Pure-JS xxHash implementations for the checksum algorithms AWS S3 added in
 * April 2026: `XXHASH64` (XXH64), `XXHASH3` (XXH3, 64-bit) and `XXHASH128`
 * (XXH3, 128-bit).
 *
 * Node's `crypto` covers every other S3 checksum algorithm, but it has no
 * xxHash, and fauxqs computes checksums itself for composite multipart
 * checksums and for opt-in body validation. The algorithms are transcribed
 * from the reference implementation (Cyan4973/xxHash v0.8.3, BSD-2-Clause).
 *
 * Only the default seed (0) and the default secret are supported — that is all
 * S3 uses.
 *
 * The loops that scale with input length keep their 64-bit state as pairs of
 * 32-bit halves, for the same reason `crc64nvme` in checksum.ts does: a
 * per-word BigInt operation is roughly an order of magnitude slower than the
 * equivalent integer math, and checksums are computed on the request path.
 * Everything that runs a bounded number of times (short inputs, finalization)
 * stays on BigInt, where it reads much closer to the reference source.
 */

const MASK64 = 0xffffffffffffffffn;

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;

const PRIME32_1 = 0x9e3779b1n;
const PRIME32_2 = 0x85ebca77n;
const PRIME32_3 = 0xc2b2ae3dn;

const PRIME_MX1 = 0x165667919e3779f9n;
const PRIME_MX2 = 0x9fb21c651e98df25n;

const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK64;
const add = (a: bigint, b: bigint): bigint => (a + b) & MASK64;
const sub = (a: bigint, b: bigint): bigint => (a - b) & MASK64;

function rotl64(v: bigint, r: bigint): bigint {
  return ((v << r) | (v >> (64n - r))) & MASK64;
}

function swap64(v: bigint): bigint {
  return (
    ((v << 56n) & 0xff00000000000000n) |
    ((v << 40n) & 0x00ff000000000000n) |
    ((v << 24n) & 0x0000ff0000000000n) |
    ((v << 8n) & 0x000000ff00000000n) |
    ((v >> 8n) & 0x00000000ff000000n) |
    ((v >> 24n) & 0x0000000000ff0000n) |
    ((v >> 40n) & 0x000000000000ff00n) |
    ((v >> 56n) & 0x00000000000000ffn)
  );
}

const xorshift64 = (v: bigint, shift: bigint): bigint => v ^ (v >> shift);

/** Low 64 bits XOR high 64 bits of the 128-bit product of two 64-bit values. */
function mul128Fold64(lhs: bigint, rhs: bigint): bigint {
  const product = lhs * rhs;
  return (product & MASK64) ^ (product >> 64n);
}

// ---------------------------------------------------------------------------
// 64-bit arithmetic on 32-bit halves, for the length-scaling loops
// ---------------------------------------------------------------------------

const hi32 = (v: bigint): number => Number(v >> 32n);
const lo32 = (v: bigint): number => Number(v & 0xffffffffn);
const join64 = (hi: number, lo: number): bigint => (BigInt(hi) << 32n) | BigInt(lo);

const PRIME64_1_HI = hi32(PRIME64_1);
const PRIME64_1_LO = lo32(PRIME64_1);
const PRIME64_2_HI = hi32(PRIME64_2);
const PRIME64_2_LO = lo32(PRIME64_2);
const PRIME32_1_N = Number(PRIME32_1);

/**
 * Result of the integer 64-bit helpers, returned through module state so the
 * hot loops stay allocation-free. Every read happens immediately after the
 * call that produced it.
 */
let rHi = 0;
let rLo = 0;

/** Read a little-endian uint32. Cheaper than Buffer#readUInt32LE in these loops. */
function readU32LE(b: Buffer, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/**
 * rHi:rLo = a * b, the exact 64-bit product of two uint32s (XXH_mult32to64).
 * Accumulates in 16-bit limbs so every intermediate stays below 2^32.
 */
function mult32to64(a: number, b: number): void {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const c0 = a0 * b0;
  let c1 = (c0 >>> 16) + a1 * b0;
  let c2 = c1 >>> 16;
  c1 = (c1 & 0xffff) + a0 * b1;
  c2 += c1 >>> 16;
  rLo = (((c1 & 0xffff) << 16) | (c0 & 0xffff)) >>> 0;
  rHi = (c2 + a1 * b1) >>> 0;
}

/** rHi:rLo = (aHi:aLo * bHi:bLo) mod 2^64. */
function mulLow64(aHi: number, aLo: number, bHi: number, bLo: number): void {
  mult32to64(aLo, bLo);
  // aHi*bHi lands entirely above bit 63, so of the two cross products only
  // their low 32 bits survive the truncation to 64 bits.
  rHi = (rHi + Math.imul(aLo, bHi) + Math.imul(aHi, bLo)) >>> 0;
}

// ---------------------------------------------------------------------------
// XXH64
// ---------------------------------------------------------------------------

function xxh64Round(acc: bigint, input: bigint): bigint {
  return mul(rotl64(add(acc, mul(input, PRIME64_2)), 31n), PRIME64_1);
}

/** rHi:rLo = xxh64Round(accHi:accLo, inputHi:inputLo). */
function xxh64Round32(accHi: number, accLo: number, inputHi: number, inputLo: number): void {
  mulLow64(inputHi, inputLo, PRIME64_2_HI, PRIME64_2_LO);
  const sumLo = accLo + rLo;
  const lo = sumLo >>> 0;
  const hi = (accHi + rHi + (sumLo > 0xffffffff ? 1 : 0)) >>> 0;
  // rotl64(_, 31), then multiply by PRIME64_1
  mulLow64(
    ((hi << 31) | (lo >>> 1)) >>> 0,
    ((lo << 31) | (hi >>> 1)) >>> 0,
    PRIME64_1_HI,
    PRIME64_1_LO,
  );
}

function xxh64MergeRound(acc: bigint, val: bigint): bigint {
  return add(mul(acc ^ xxh64Round(0n, val), PRIME64_1), PRIME64_4);
}

function xxh64Avalanche(hash: bigint): bigint {
  let h = hash ^ (hash >> 33n);
  h = mul(h, PRIME64_2);
  h ^= h >> 29n;
  h = mul(h, PRIME64_3);
  return h ^ (h >> 32n);
}

function xxh64Finalize(hash: bigint, data: Buffer, offset: number, remaining: number): bigint {
  let h = hash;
  let p = offset;
  let len = remaining & 31;
  while (len >= 8) {
    h ^= xxh64Round(0n, data.readBigUInt64LE(p));
    p += 8;
    h = add(mul(rotl64(h, 27n), PRIME64_1), PRIME64_4);
    len -= 8;
  }
  if (len >= 4) {
    h ^= mul(BigInt(data.readUInt32LE(p)), PRIME64_1);
    p += 4;
    h = add(mul(rotl64(h, 23n), PRIME64_2), PRIME64_3);
    len -= 4;
  }
  while (len > 0) {
    h ^= mul(BigInt(data[p]), PRIME64_5);
    p += 1;
    h = mul(rotl64(h, 11n), PRIME64_1);
    len -= 1;
  }
  return xxh64Avalanche(h);
}

/** Compute XXH64 of a buffer, returning a uint64 as a bigint. */
export function xxh64(data: Buffer, seed: bigint = 0n): bigint {
  const len = data.length;
  const s = seed & MASK64;
  let h64: bigint;
  let p = 0;

  if (len >= 32) {
    // The striped loop runs once per 8 bytes, so it carries the four
    // accumulators as 32-bit halves and rejoins them for the merge below.
    const init0 = add(add(s, PRIME64_1), PRIME64_2);
    const init1 = add(s, PRIME64_2);
    const init3 = sub(s, PRIME64_1);
    let a0Hi = hi32(init0);
    let a0Lo = lo32(init0);
    let a1Hi = hi32(init1);
    let a1Lo = lo32(init1);
    let a2Hi = hi32(s);
    let a2Lo = lo32(s);
    let a3Hi = hi32(init3);
    let a3Lo = lo32(init3);
    const limit = len - 31;
    do {
      xxh64Round32(a0Hi, a0Lo, readU32LE(data, p + 4), readU32LE(data, p));
      a0Hi = rHi;
      a0Lo = rLo;
      xxh64Round32(a1Hi, a1Lo, readU32LE(data, p + 12), readU32LE(data, p + 8));
      a1Hi = rHi;
      a1Lo = rLo;
      xxh64Round32(a2Hi, a2Lo, readU32LE(data, p + 20), readU32LE(data, p + 16));
      a2Hi = rHi;
      a2Lo = rLo;
      xxh64Round32(a3Hi, a3Lo, readU32LE(data, p + 28), readU32LE(data, p + 24));
      a3Hi = rHi;
      a3Lo = rLo;
      p += 32;
    } while (p < limit);

    const acc0 = join64(a0Hi, a0Lo);
    const acc1 = join64(a1Hi, a1Lo);
    const acc2 = join64(a2Hi, a2Lo);
    const acc3 = join64(a3Hi, a3Lo);
    h64 = add(add(rotl64(acc0, 1n), rotl64(acc1, 7n)), add(rotl64(acc2, 12n), rotl64(acc3, 18n)));
    h64 = xxh64MergeRound(h64, acc0);
    h64 = xxh64MergeRound(h64, acc1);
    h64 = xxh64MergeRound(h64, acc2);
    h64 = xxh64MergeRound(h64, acc3);
  } else {
    h64 = add(s, PRIME64_5);
  }

  h64 = add(h64, BigInt(len));
  return xxh64Finalize(h64, data, p, len);
}

// ---------------------------------------------------------------------------
// XXH3 (64- and 128-bit), default seed and default secret
// ---------------------------------------------------------------------------

/** The default XXH3 secret ("kSecret"), taken directly from the reference implementation. */
// prettier-ignore
const SECRET = Buffer.from([
  0xb8, 0xfe, 0x6c, 0x39, 0x23, 0xa4, 0x4b, 0xbe, 0x7c, 0x01, 0x81, 0x2c, 0xf7, 0x21, 0xad, 0x1c,
  0xde, 0xd4, 0x6d, 0xe9, 0x83, 0x90, 0x97, 0xdb, 0x72, 0x40, 0xa4, 0xa4, 0xb7, 0xb3, 0x67, 0x1f,
  0xcb, 0x79, 0xe6, 0x4e, 0xcc, 0xc0, 0xe5, 0x78, 0x82, 0x5a, 0xd0, 0x7d, 0xcc, 0xff, 0x72, 0x21,
  0xb8, 0x08, 0x46, 0x74, 0xf7, 0x43, 0x24, 0x8e, 0xe0, 0x35, 0x90, 0xe6, 0x81, 0x3a, 0x26, 0x4c,
  0x3c, 0x28, 0x52, 0xbb, 0x91, 0xc3, 0x00, 0xcb, 0x88, 0xd0, 0x65, 0x8b, 0x1b, 0x53, 0x2e, 0xa3,
  0x71, 0x64, 0x48, 0x97, 0xa2, 0x0d, 0xf9, 0x4e, 0x38, 0x19, 0xef, 0x46, 0xa9, 0xde, 0xac, 0xd8,
  0xa8, 0xfa, 0x76, 0x3f, 0xe3, 0x9c, 0x34, 0x3f, 0xf9, 0xdc, 0xbb, 0xc7, 0xc7, 0x0b, 0x4f, 0x1d,
  0x8a, 0x51, 0xe0, 0x4b, 0xcd, 0xb4, 0x59, 0x31, 0xc8, 0x9f, 0x7e, 0xc9, 0xd9, 0x78, 0x73, 0x64,
  0xea, 0xc5, 0xac, 0x83, 0x34, 0xd3, 0xeb, 0xc3, 0xc5, 0x81, 0xa0, 0xff, 0xfa, 0x13, 0x63, 0xeb,
  0x17, 0x0d, 0xdd, 0x51, 0xb7, 0xf0, 0xda, 0x49, 0xd3, 0x16, 0x55, 0x26, 0x29, 0xd4, 0x68, 0x9e,
  0x2b, 0x16, 0xbe, 0x58, 0x7d, 0x47, 0xa1, 0xfc, 0x8f, 0xf8, 0xb8, 0xd1, 0x7a, 0xd0, 0x31, 0xce,
  0x45, 0xcb, 0x3a, 0x8f, 0x95, 0x16, 0x04, 0x28, 0xaf, 0xd7, 0xfb, 0xca, 0xbb, 0x4b, 0x40, 0x7e,
]);

const STRIPE_LEN = 64;
const SECRET_CONSUME_RATE = 8;
const ACC_NB = 8;
const SECRET_LASTACC_START = 7;
const SECRET_MERGEACCS_START = 11;
const SECRET_SIZE_MIN = 136;
const MIDSIZE_MAX = 240;
const MIDSIZE_STARTOFFSET = 3;
const MIDSIZE_LASTOFFSET = 17;

/** Secret pre-read as little-endian 64-bit words at every byte offset that XXH3 uses. */
const SECRET64: bigint[] = Array.from({ length: SECRET.length - 7 }, (_, i) =>
  SECRET.readBigUInt64LE(i),
);
const SECRET32: number[] = Array.from({ length: SECRET.length - 3 }, (_, i) =>
  SECRET.readUInt32LE(i),
);
/** The same secret words split into halves, for the striped long path. */
const SECRET_HI = new Uint32Array(SECRET64.map(hi32));
const SECRET_LO = new Uint32Array(SECRET64.map(lo32));

function xxh3Avalanche(h: bigint): bigint {
  let x = xorshift64(h, 37n);
  x = mul(x, PRIME_MX1);
  return xorshift64(x, 32n);
}

function xxh3Rrmxmx(h: bigint, len: number): bigint {
  let x = h ^ rotl64(h, 49n) ^ rotl64(h, 24n);
  x = mul(x, PRIME_MX2);
  x ^= add(x >> 35n, BigInt(len));
  x = mul(x, PRIME_MX2);
  return xorshift64(x, 28n);
}

/** Mixes 16 bytes of input against 16 bytes of secret. Seed is always 0 here. */
function mix16B(input: Buffer, inputOffset: number, secretOffset: number): bigint {
  return mul128Fold64(
    input.readBigUInt64LE(inputOffset) ^ SECRET64[secretOffset],
    input.readBigUInt64LE(inputOffset + 8) ^ SECRET64[secretOffset + 8],
  );
}

function len1to3_64b(input: Buffer, len: number): bigint {
  const c1 = input[0];
  const c2 = input[len >> 1];
  const c3 = input[len - 1];
  const combined = ((c1 << 16) | (c2 << 24) | c3 | (len << 8)) >>> 0;
  const bitflip = BigInt((SECRET32[0] ^ SECRET32[4]) >>> 0);
  return xxh64Avalanche(BigInt(combined) ^ bitflip);
}

function len4to8_64b(input: Buffer, len: number): bigint {
  const input1 = BigInt(input.readUInt32LE(0));
  const input2 = BigInt(input.readUInt32LE(len - 4));
  const bitflip = SECRET64[8] ^ SECRET64[16];
  const input64 = add(input2, input1 << 32n);
  return xxh3Rrmxmx(input64 ^ bitflip, len);
}

function len9to16_64b(input: Buffer, len: number): bigint {
  const bitflip1 = SECRET64[24] ^ SECRET64[32];
  const bitflip2 = SECRET64[40] ^ SECRET64[48];
  const inputLo = input.readBigUInt64LE(0) ^ bitflip1;
  const inputHi = input.readBigUInt64LE(len - 8) ^ bitflip2;
  const acc = add(add(BigInt(len), swap64(inputLo)), add(inputHi, mul128Fold64(inputLo, inputHi)));
  return xxh3Avalanche(acc);
}

function len0to16_64b(input: Buffer, len: number): bigint {
  if (len > 8) return len9to16_64b(input, len);
  if (len >= 4) return len4to8_64b(input, len);
  if (len > 0) return len1to3_64b(input, len);
  return xxh64Avalanche(SECRET64[56] ^ SECRET64[64]);
}

function len17to128_64b(input: Buffer, len: number): bigint {
  let acc = mul(BigInt(len), PRIME64_1);
  if (len > 32) {
    if (len > 64) {
      if (len > 96) {
        acc = add(acc, mix16B(input, 48, 96));
        acc = add(acc, mix16B(input, len - 64, 112));
      }
      acc = add(acc, mix16B(input, 32, 64));
      acc = add(acc, mix16B(input, len - 48, 80));
    }
    acc = add(acc, mix16B(input, 16, 32));
    acc = add(acc, mix16B(input, len - 32, 48));
  }
  acc = add(acc, mix16B(input, 0, 0));
  acc = add(acc, mix16B(input, len - 16, 16));
  return xxh3Avalanche(acc);
}

function len129to240_64b(input: Buffer, len: number): bigint {
  const nbRounds = Math.floor(len / 16);
  let acc = mul(BigInt(len), PRIME64_1);
  for (let i = 0; i < 8; i++) {
    acc = add(acc, mix16B(input, 16 * i, 16 * i));
  }
  let accEnd = mix16B(input, len - 16, SECRET_SIZE_MIN - MIDSIZE_LASTOFFSET);
  acc = xxh3Avalanche(acc);
  for (let i = 8; i < nbRounds; i++) {
    accEnd = add(accEnd, mix16B(input, 16 * i, 16 * (i - 8) + MIDSIZE_STARTOFFSET));
  }
  return xxh3Avalanche(add(acc, accEnd));
}

const INIT_ACC: readonly bigint[] = [
  PRIME32_3,
  PRIME64_1,
  PRIME64_2,
  PRIME64_3,
  PRIME64_4,
  PRIME32_2,
  PRIME64_5,
  PRIME32_1,
];

const INIT_ACC_HI = new Uint32Array(INIT_ACC.map(hi32));
const INIT_ACC_LO = new Uint32Array(INIT_ACC.map(lo32));

/**
 * Consume one 64-byte stripe into the eight accumulators. Runs once per 64
 * bytes of input, so it stays on 32-bit halves throughout; Uint32Array stores
 * wrap at 2^32, which is exactly the modular arithmetic the 64-bit adds need.
 */
function accumulate512(
  accHi: Uint32Array,
  accLo: Uint32Array,
  input: Buffer,
  inputOffset: number,
  secretOffset: number,
): void {
  for (let lane = 0; lane < ACC_NB; lane++) {
    const io = inputOffset + lane * 8;
    const dataLo = readU32LE(input, io);
    const dataHi = readU32LE(input, io + 4);
    const so = secretOffset + lane * 8;

    // acc[lane ^ 1] += dataVal
    const swapped = lane ^ 1;
    const sumLo = accLo[swapped] + dataLo;
    accLo[swapped] = sumLo;
    accHi[swapped] = accHi[swapped] + dataHi + (sumLo > 0xffffffff ? 1 : 0);

    // acc[lane] += (dataKey & 0xffffffff) * (dataKey >> 32)
    mult32to64((dataLo ^ SECRET_LO[so]) >>> 0, (dataHi ^ SECRET_HI[so]) >>> 0);
    const mixLo = accLo[lane] + rLo;
    accLo[lane] = mixLo;
    accHi[lane] = accHi[lane] + rHi + (mixLo > 0xffffffff ? 1 : 0);
  }
}

function scrambleAcc(accHi: Uint32Array, accLo: Uint32Array, secretOffset: number): void {
  for (let lane = 0; lane < ACC_NB; lane++) {
    const hi = accHi[lane];
    const so = secretOffset + lane * 8;
    // xorshift64(acc, 47) shifts everything out of the high half, so only the
    // low half of the accumulator changes.
    const keyLo = (accLo[lane] ^ (hi >>> 15) ^ SECRET_LO[so]) >>> 0;
    const keyHi = (hi ^ SECRET_HI[so]) >>> 0;
    mulLow64(keyHi, keyLo, 0, PRIME32_1_N);
    accLo[lane] = rLo;
    accHi[lane] = rHi;
  }
}

function hashLongAccumulate(input: Buffer): { accHi: Uint32Array; accLo: Uint32Array } {
  const accHi = INIT_ACC_HI.slice();
  const accLo = INIT_ACC_LO.slice();
  const len = input.length;
  const nbStripesPerBlock = (SECRET.length - STRIPE_LEN) / SECRET_CONSUME_RATE;
  const blockLen = STRIPE_LEN * nbStripesPerBlock;
  const nbBlocks = Math.floor((len - 1) / blockLen);

  for (let n = 0; n < nbBlocks; n++) {
    for (let stripe = 0; stripe < nbStripesPerBlock; stripe++) {
      accumulate512(
        accHi,
        accLo,
        input,
        n * blockLen + stripe * STRIPE_LEN,
        stripe * SECRET_CONSUME_RATE,
      );
    }
    scrambleAcc(accHi, accLo, SECRET.length - STRIPE_LEN);
  }

  const nbStripes = Math.floor((len - 1 - blockLen * nbBlocks) / STRIPE_LEN);
  for (let stripe = 0; stripe < nbStripes; stripe++) {
    accumulate512(
      accHi,
      accLo,
      input,
      nbBlocks * blockLen + stripe * STRIPE_LEN,
      stripe * SECRET_CONSUME_RATE,
    );
  }

  accumulate512(
    accHi,
    accLo,
    input,
    len - STRIPE_LEN,
    SECRET.length - STRIPE_LEN - SECRET_LASTACC_START,
  );
  return { accHi, accLo };
}

function mergeAccs(
  accHi: Uint32Array,
  accLo: Uint32Array,
  secretOffset: number,
  start: bigint,
): bigint {
  let result = start;
  for (let i = 0; i < 4; i++) {
    result = add(
      result,
      mul128Fold64(
        join64(accHi[2 * i], accLo[2 * i]) ^ SECRET64[secretOffset + 16 * i],
        join64(accHi[2 * i + 1], accLo[2 * i + 1]) ^ SECRET64[secretOffset + 16 * i + 8],
      ),
    );
  }
  return xxh3Avalanche(result);
}

/** Compute XXH3 (64-bit) of a buffer with the default seed, returning a uint64 as a bigint. */
export function xxh3_64(input: Buffer): bigint {
  const len = input.length;
  if (len <= 16) return len0to16_64b(input, len);
  if (len <= 128) return len17to128_64b(input, len);
  if (len <= MIDSIZE_MAX) return len129to240_64b(input, len);
  const { accHi, accLo } = hashLongAccumulate(input);
  return mergeAccs(accHi, accLo, SECRET_MERGEACCS_START, mul(BigInt(len), PRIME64_1));
}

// --- 128-bit variants ---

export interface Uint128 {
  high: bigint;
  low: bigint;
}

function len1to3_128b(input: Buffer, len: number): Uint128 {
  const c1 = input[0];
  const c2 = input[len >> 1];
  const c3 = input[len - 1];
  const combinedl = ((c1 << 16) | (c2 << 24) | c3 | (len << 8)) >>> 0;
  // 32-bit rotate-left by 13 of the byte-swapped low combination
  const swapped =
    (((combinedl & 0xff) << 24) |
      ((combinedl & 0xff00) << 8) |
      ((combinedl >>> 8) & 0xff00) |
      (combinedl >>> 24)) >>>
    0;
  const combinedh = ((swapped << 13) | (swapped >>> 19)) >>> 0;
  const bitflipl = BigInt((SECRET32[0] ^ SECRET32[4]) >>> 0);
  const bitfliph = BigInt((SECRET32[8] ^ SECRET32[12]) >>> 0);
  return {
    low: xxh64Avalanche(BigInt(combinedl) ^ bitflipl),
    high: xxh64Avalanche(BigInt(combinedh) ^ bitfliph),
  };
}

function len4to8_128b(input: Buffer, len: number): Uint128 {
  const inputLo = BigInt(input.readUInt32LE(0));
  const inputHi = BigInt(input.readUInt32LE(len - 4));
  const input64 = add(inputLo, inputHi << 32n);
  const bitflip = SECRET64[16] ^ SECRET64[24];
  const keyed = input64 ^ bitflip;

  const product = keyed * add(PRIME64_1, BigInt(len << 2));
  let low = product & MASK64;
  let high = product >> 64n;

  high = add(high, (low << 1n) & MASK64);
  low ^= high >> 3n;
  low = xorshift64(low, 35n);
  low = mul(low, PRIME_MX2);
  low = xorshift64(low, 28n);
  return { low, high: xxh3Avalanche(high) };
}

function len9to16_128b(input: Buffer, len: number): Uint128 {
  const bitflipl = SECRET64[32] ^ SECRET64[40];
  const bitfliph = SECRET64[48] ^ SECRET64[56];
  const inputLo = input.readBigUInt64LE(0);
  let inputHi = input.readBigUInt64LE(len - 8);

  const product = (inputLo ^ inputHi ^ bitflipl) * PRIME64_1;
  let mLow = product & MASK64;
  let mHigh = product >> 64n;

  mLow = add(mLow, BigInt(len - 1) << 54n);
  inputHi ^= bitfliph;
  mHigh = add(mHigh, add(inputHi, (inputHi & 0xffffffffn) * (PRIME32_2 - 1n)));
  mLow ^= swap64(mHigh);

  const h = mLow * PRIME64_2;
  const low = h & MASK64;
  const high = add(h >> 64n, mul(mHigh, PRIME64_2));
  return { low: xxh3Avalanche(low), high: xxh3Avalanche(high) };
}

function len0to16_128b(input: Buffer, len: number): Uint128 {
  if (len > 8) return len9to16_128b(input, len);
  if (len >= 4) return len4to8_128b(input, len);
  if (len > 0) return len1to3_128b(input, len);
  return {
    low: xxh64Avalanche(SECRET64[64] ^ SECRET64[72]),
    high: xxh64Avalanche(SECRET64[80] ^ SECRET64[88]),
  };
}

function mix32B(
  acc: Uint128,
  input: Buffer,
  offset1: number,
  offset2: number,
  secretOffset: number,
): Uint128 {
  let low = add(acc.low, mix16B(input, offset1, secretOffset));
  low ^= add(input.readBigUInt64LE(offset2), input.readBigUInt64LE(offset2 + 8));
  let high = add(acc.high, mix16B(input, offset2, secretOffset + 16));
  high ^= add(input.readBigUInt64LE(offset1), input.readBigUInt64LE(offset1 + 8));
  return { low, high };
}

function finalizeMidsize128b(acc: Uint128, len: number): Uint128 {
  const low = add(acc.low, acc.high);
  const high = add(
    add(mul(acc.low, PRIME64_1), mul(acc.high, PRIME64_4)),
    mul(BigInt(len), PRIME64_2),
  );
  return { low: xxh3Avalanche(low), high: sub(0n, xxh3Avalanche(high)) };
}

function len17to128_128b(input: Buffer, len: number): Uint128 {
  let acc: Uint128 = { low: mul(BigInt(len), PRIME64_1), high: 0n };
  if (len > 32) {
    if (len > 64) {
      if (len > 96) {
        acc = mix32B(acc, input, 48, len - 64, 96);
      }
      acc = mix32B(acc, input, 32, len - 48, 64);
    }
    acc = mix32B(acc, input, 16, len - 32, 32);
  }
  acc = mix32B(acc, input, 0, len - 16, 0);
  return finalizeMidsize128b(acc, len);
}

function len129to240_128b(input: Buffer, len: number): Uint128 {
  let acc: Uint128 = { low: mul(BigInt(len), PRIME64_1), high: 0n };
  for (let i = 32; i < 160; i += 32) {
    acc = mix32B(acc, input, i - 32, i - 16, i - 32);
  }
  acc = { low: xxh3Avalanche(acc.low), high: xxh3Avalanche(acc.high) };
  for (let i = 160; i <= len; i += 32) {
    acc = mix32B(acc, input, i - 32, i - 16, MIDSIZE_STARTOFFSET + i - 160);
  }
  // Last 32 bytes, deliberately in reverse order.
  acc = mix32B(acc, input, len - 16, len - 32, SECRET_SIZE_MIN - MIDSIZE_LASTOFFSET - 16);
  return finalizeMidsize128b(acc, len);
}

/** Compute XXH3 (128-bit) of a buffer with the default seed. */
export function xxh3_128(input: Buffer): Uint128 {
  const len = input.length;
  if (len <= 16) return len0to16_128b(input, len);
  if (len <= 128) return len17to128_128b(input, len);
  if (len <= MIDSIZE_MAX) return len129to240_128b(input, len);

  const { accHi, accLo } = hashLongAccumulate(input);
  const lenBig = BigInt(len);
  return {
    low: mergeAccs(accHi, accLo, SECRET_MERGEACCS_START, mul(lenBig, PRIME64_1)),
    high: mergeAccs(
      accHi,
      accLo,
      SECRET.length - STRIPE_LEN - SECRET_MERGEACCS_START,
      mul(lenBig, PRIME64_2) ^ MASK64,
    ),
  };
}
