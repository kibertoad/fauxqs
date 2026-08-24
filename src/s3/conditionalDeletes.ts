import { S3Error } from "../common/errors.ts";
import { etagEquals, parseEtagList, preconditionFailed } from "./conditionalWrites.ts";

/**
 * Preconditions a conditional delete carries. `ifMatch` is the `If-Match` header
 * on DeleteObject or the per-object `<ETag>` element in a DeleteObjects body;
 * the other two are the directory-bucket-only `x-amz-if-match-last-modified-time`
 * and `x-amz-if-match-size` headers, or their `<LastModifiedTime>` / `<Size>`
 * body equivalents.
 */
export interface DeletePreconditions {
  ifMatch?: string;
  ifMatchLastModifiedTime?: string;
  ifMatchSize?: string;
}

/** The stored-object fields a delete precondition is evaluated against. */
export interface DeleteTarget {
  etag: string;
  lastModified: Date;
  contentLength: number;
}

/** Header and body names of the two preconditions only directory buckets accept. */
export const DIRECTORY_ONLY_DELETE_PRECONDITIONS = {
  ifMatchLastModifiedTime: "x-amz-if-match-last-modified-time",
  ifMatchSize: "x-amz-if-match-size",
} as const;

export function hasDeletePreconditions(preconditions: DeletePreconditions): boolean {
  return (
    preconditions.ifMatch !== undefined ||
    preconditions.ifMatchLastModifiedTime !== undefined ||
    preconditions.ifMatchSize !== undefined
  );
}

/**
 * Reject the two directory-bucket-only preconditions on a general-purpose bucket,
 * the way S3 rejects input whose functionality it does not offer. `names` carries
 * the header names for DeleteObject and the body element names for DeleteObjects.
 */
export function rejectDirectoryOnlyPreconditions(
  preconditions: DeletePreconditions,
  names: { ifMatchLastModifiedTime: string; ifMatchSize: string },
  subject: "header" | "element" = "header",
): void {
  const unsupported =
    preconditions.ifMatchLastModifiedTime !== undefined
      ? names.ifMatchLastModifiedTime
      : preconditions.ifMatchSize !== undefined
        ? names.ifMatchSize
        : undefined;
  if (unsupported) {
    throw new S3Error(
      "NotImplemented",
      `A ${subject} you provided implies functionality that is not implemented: ${unsupported} is only supported for directory buckets`,
      501,
    );
  }
}

/**
 * Evaluate S3 conditional-delete preconditions against the object currently
 * stored at the target key (`undefined` when the key holds nothing).
 *
 * - `If-Match: *`    — asserts only that the object exists; 412 when it does not.
 * - `If-Match: etag` — 404 NoSuchKey when the key is empty (AWS answers "Not
 *   Found" there rather than 412), 412 when the stored ETag differs.
 * - `x-amz-if-match-last-modified-time` / `x-amz-if-match-size` — 412 only when a
 *   stored object disagrees. AWS documents a 204 when the object is already gone,
 *   so these two pass on an empty key.
 *
 * Applies to DeleteObject and to each object in a DeleteObjects batch.
 */
export function checkConditionalDelete(
  preconditions: DeletePreconditions,
  existing: DeleteTarget | undefined,
  resource?: string,
): void {
  const { ifMatch, ifMatchLastModifiedTime, ifMatchSize } = preconditions;

  // Parse before comparing: a malformed value is rejected whether or not the key
  // currently holds an object.
  const expectedTime =
    ifMatchLastModifiedTime === undefined ? undefined : parseHttpDate(ifMatchLastModifiedTime);
  const expectedSize = ifMatchSize === undefined ? undefined : parseSize(ifMatchSize);

  if (ifMatch !== undefined) {
    const tags = parseEtagList(ifMatch);
    if (tags.includes("*")) {
      if (!existing) throw preconditionFailed();
    } else if (!existing) {
      throw new S3Error("NoSuchKey", "The specified key does not exist.", 404, resource);
    } else if (!tags.some((tag) => etagEquals(existing.etag, tag))) {
      throw preconditionFailed();
    }
  }

  if (!existing) return;

  // The wire format is an HTTP-date, which carries whole seconds, so a stored
  // timestamp has to be compared at second granularity.
  if (
    expectedTime !== undefined &&
    expectedTime !== truncateToSeconds(existing.lastModified.getTime())
  ) {
    throw preconditionFailed();
  }

  if (expectedSize !== undefined && expectedSize !== existing.contentLength) {
    throw preconditionFailed();
  }
}

function parseHttpDate(raw: string): number {
  const parsed = Date.parse(raw.trim());
  if (Number.isNaN(parsed)) {
    throw new S3Error("InvalidArgument", `Invalid last modified time precondition: ${raw}`, 400);
  }
  return truncateToSeconds(parsed);
}

function parseSize(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new S3Error("InvalidArgument", `Invalid size precondition: ${raw}`, 400);
  }
  return Number(trimmed);
}

function truncateToSeconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/** Read a precondition value, treating a missing or blank one as absent. */
function preconditionHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** Collect the conditional-delete headers off a DeleteObject request. */
export function deletePreconditionsFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): DeletePreconditions {
  return {
    ifMatch: preconditionHeader(headers, "if-match"),
    ifMatchLastModifiedTime: preconditionHeader(
      headers,
      DIRECTORY_ONLY_DELETE_PRECONDITIONS.ifMatchLastModifiedTime,
    ),
    ifMatchSize: preconditionHeader(headers, DIRECTORY_ONLY_DELETE_PRECONDITIONS.ifMatchSize),
  };
}
