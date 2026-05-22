import { S3Error } from "../common/errors.ts";

function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  // Preserve every value: a repeated header and a single comma-separated header
  // are equivalent under RFC 7232, and both must be evaluated as a list.
  return Array.isArray(v) ? v.join(",") : v;
}

/** Split a comma-separated entity-tag list (RFC 7232) into individual tokens. */
function parseEtagList(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Normalize an ETag for comparison: strip a weak-validator prefix and surrounding quotes. */
export function normalizeEtag(etag: string): string {
  let e = etag.trim();
  if (e.startsWith("W/")) e = e.slice(2);
  if (e.length >= 2 && e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1);
  return e;
}

/** Compare two ETags ignoring weak-validator prefixes and surrounding quotes. */
export function etagEquals(a: string, b: string): boolean {
  return normalizeEtag(a) === normalizeEtag(b);
}

function preconditionFailed(): S3Error {
  return new S3Error(
    "PreconditionFailed",
    "At least one of the pre-conditions you specified did not hold",
    412,
  );
}

/**
 * Evaluate S3 conditional-write preconditions (`If-None-Match` / `If-Match`) for a
 * write to a destination key. `existing` is the object currently stored at that
 * key, or `undefined` when the key is empty.
 *
 * - `If-None-Match: *`    — fails when an object already exists (prevents overwrites).
 * - `If-None-Match: etag` — fails when the existing object's ETag matches.
 * - `If-Match: etag`      — fails when no object exists, or its ETag does not match
 *   (compare-and-swap).
 *
 * Applies to PutObject, CompleteMultipartUpload, and CopyObject. Throws a
 * `412 PreconditionFailed` S3Error when a precondition does not hold.
 */
export function checkConditionalWrite(
  headers: Record<string, string | string[] | undefined>,
  existing: { etag: string } | undefined,
): void {
  const ifNoneMatch = headerValue(headers["if-none-match"]);
  if (ifNoneMatch !== undefined) {
    // If-None-Match is "none-of": fail when any listed tag (or `*`) matches.
    const values = parseEtagList(ifNoneMatch);
    if (values.includes("*")) {
      if (existing) throw preconditionFailed();
    } else if (existing && values.some((v) => etagEquals(existing.etag, v))) {
      throw preconditionFailed();
    }
  }

  const ifMatch = headerValue(headers["if-match"]);
  if (ifMatch !== undefined) {
    // If-Match is "any-of": pass when `*` is listed and the object exists, or
    // when any listed tag matches; fail otherwise.
    const values = parseEtagList(ifMatch);
    if (!existing) {
      throw preconditionFailed();
    }
    if (!values.includes("*") && !values.some((v) => etagEquals(existing.etag, v))) {
      throw preconditionFailed();
    }
  }
}
