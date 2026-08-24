import { S3Error } from "../common/errors.ts";
import { etagEquals, headerValue, parseEtagList, preconditionFailed } from "./conditionalWrites.ts";

/**
 * Preconditions a conditional delete carries, as they arrived on the wire.
 * `ifMatch` is the `If-Match` header on DeleteObject or the per-object `<ETag>`
 * element in a DeleteObjects body; the other two are the directory-bucket-only
 * `x-amz-if-match-last-modified-time` and `x-amz-if-match-size` headers, or their
 * `<LastModifiedTime>` / `<Size>` body equivalents.
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

/**
 * The two preconditions only directory buckets accept, each with the header name
 * DeleteObject reads it from and the body element name DeleteObjects reads it
 * from. Keyed by {@link DeletePreconditions} field so one precondition's two
 * spellings cannot drift apart.
 */
export const DIRECTORY_ONLY_DELETE_PRECONDITIONS = {
  ifMatchLastModifiedTime: {
    header: "x-amz-if-match-last-modified-time",
    element: "LastModifiedTime",
  },
  ifMatchSize: {
    header: "x-amz-if-match-size",
    element: "Size",
  },
} as const;

/** Which spelling of a precondition's name an error message should quote. */
export type PreconditionSubject = "header" | "element";

export function hasDeletePreconditions(preconditions: DeletePreconditions): boolean {
  return (
    preconditions.ifMatch !== undefined ||
    preconditions.ifMatchLastModifiedTime !== undefined ||
    preconditions.ifMatchSize !== undefined
  );
}

/**
 * The `501 NotImplemented` a general-purpose bucket owes a directory-bucket-only
 * precondition, or `undefined` when none is present. AWS scopes both to directory
 * buckets, and silently ignoring a precondition is the one outcome worse than
 * rejecting it: the caller believes it got a compare-and-swap. DeleteObject
 * throws this for the whole request, DeleteObjects reports it against the single
 * object that carried it.
 */
export function directoryOnlyPreconditionError(
  preconditions: DeletePreconditions,
  subject: PreconditionSubject,
): S3Error | undefined {
  const field =
    preconditions.ifMatchLastModifiedTime !== undefined
      ? "ifMatchLastModifiedTime"
      : preconditions.ifMatchSize !== undefined
        ? "ifMatchSize"
        : undefined;
  if (field === undefined) return undefined;
  const name = DIRECTORY_ONLY_DELETE_PRECONDITIONS[field][subject];
  const article = subject === "element" ? "An" : "A";
  return new S3Error(
    "NotImplemented",
    `${article} ${subject} you provided implies functionality that is not implemented: ${name} is only supported for directory buckets`,
    501,
  );
}

/**
 * A timestamp precondition, with the precision the client actually expressed.
 * An HTTP-date names a whole second and nothing finer, so it is compared against
 * a stored timestamp truncated to seconds; an RFC-3339 value carrying a non-zero
 * fraction claimed milliseconds and is compared exactly.
 */
interface ExpectedTime {
  ms: number;
  wholeSeconds: boolean;
}

/** Delete preconditions whose values have been parsed and validated. */
export interface ParsedDeletePreconditions {
  ifMatch?: string;
  expectedTime?: ExpectedTime;
  expectedSize?: number;
}

/**
 * Parse and validate a conditional delete's values without consulting the store.
 * Split out from {@link checkConditionalDelete} so a malformed value fails the
 * request as the `400 InvalidArgument` it is — in a DeleteObjects batch that means
 * before the first key is touched, rather than as a per-object verdict under a
 * `200 OK`.
 */
export function parseDeletePreconditions(
  preconditions: DeletePreconditions,
): ParsedDeletePreconditions {
  const { ifMatch, ifMatchLastModifiedTime, ifMatchSize } = preconditions;
  return {
    ifMatch,
    expectedTime:
      ifMatchLastModifiedTime === undefined ? undefined : parseTimestamp(ifMatchLastModifiedTime),
    expectedSize: ifMatchSize === undefined ? undefined : parseSize(ifMatchSize),
  };
}

/**
 * Evaluate parsed conditional-delete preconditions against the object currently
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
  preconditions: ParsedDeletePreconditions,
  existing: DeleteTarget | undefined,
  resource?: string,
): void {
  const { ifMatch, expectedTime, expectedSize } = preconditions;

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

  if (expectedTime !== undefined) {
    const stored = existing.lastModified.getTime();
    const comparable = expectedTime.wholeSeconds ? truncateToSeconds(stored) : stored;
    if (expectedTime.ms !== comparable) throw preconditionFailed();
  }

  if (expectedSize !== undefined && expectedSize !== existing.contentLength) {
    throw preconditionFailed();
  }
}

/** An HTTP-date, the wire format of `x-amz-if-match-last-modified-time`. */
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * An RFC-3339 date-time with an explicit offset, the wire format the SDK
 * serialises a `<LastModifiedTime>` element as. The offset is required: `Date.parse`
 * reads an offset-less `2026-08-24T13:17:23` as *local* time, which would make the
 * precondition pass or fail by the host's UTC offset.
 */
const RFC_3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * Match the shape before parsing. `Date.parse` on its own is far too permissive
 * to validate a timestamp with: it reads `"999"` as the year 999, so a typo or a
 * unit mix-up would surface as a plain 412 and send the caller hunting for clock
 * drift that isn't there.
 */
function parseTimestamp(raw: string): ExpectedTime {
  const trimmed = raw.trim();
  const rfc3339 = RFC_3339.exec(trimmed);
  if (!rfc3339 && !HTTP_DATE.test(trimmed)) throw invalidTimestamp(raw);
  // A well-shaped string can still name an impossible instant, e.g. month 13.
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) throw invalidTimestamp(raw);
  // A zero fraction says nothing the second did not: it is what a second-granular
  // value looks like once formatted with millisecond precision, which is all S3
  // ever hands a client back. Only a non-zero fraction is a claim about millis.
  const fraction = rfc3339?.[1];
  return { ms, wholeSeconds: fraction === undefined || Number(fraction) === 0 };
}

function invalidTimestamp(raw: string): S3Error {
  return new S3Error("InvalidArgument", `Invalid last modified time precondition: ${raw}`, 400);
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

/** Collect the conditional-delete headers off a DeleteObject request. */
export function deletePreconditionsFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): DeletePreconditions {
  return {
    ifMatch: headerValue(headers["if-match"]),
    ifMatchLastModifiedTime: headerValue(
      headers[DIRECTORY_ONLY_DELETE_PRECONDITIONS.ifMatchLastModifiedTime.header],
    ),
    ifMatchSize: headerValue(headers[DIRECTORY_ONLY_DELETE_PRECONDITIONS.ifMatchSize.header]),
  };
}
