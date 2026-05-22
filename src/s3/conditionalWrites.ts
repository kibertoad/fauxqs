import { S3Error } from "../common/errors.ts";

function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Normalize an ETag for comparison: strip a weak-validator prefix and surrounding quotes. */
function normalizeEtag(etag: string): string {
  let e = etag.trim();
  if (e.startsWith("W/")) e = e.slice(2);
  if (e.length >= 2 && e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1);
  return e;
}

function etagEquals(a: string, b: string): boolean {
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
    const trimmed = ifNoneMatch.trim();
    if (trimmed === "*") {
      if (existing) throw preconditionFailed();
    } else if (existing && etagEquals(existing.etag, trimmed)) {
      throw preconditionFailed();
    }
  }

  const ifMatch = headerValue(headers["if-match"]);
  if (ifMatch !== undefined) {
    if (!existing || !etagEquals(existing.etag, ifMatch)) {
      throw preconditionFailed();
    }
  }
}
