import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import { escapeXml, unescapeXml, xmlBlocks, xmlElement, xmlTagsClosed } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";
import {
  type DeletePreconditions,
  type ParsedDeletePreconditions,
  checkConditionalDelete,
  directoryOnlyPreconditionError,
  hasDeletePreconditions,
  parseDeletePreconditions,
} from "../conditionalDeletes.ts";

/** The verdicts that belong in the response body rather than failing the request. */
const PER_OBJECT_ERROR_CODES = new Set(["PreconditionFailed", "NoSuchKey"]);

interface RequestedDelete {
  key: string;
  preconditions: DeletePreconditions;
}

/** One object's fate, decided before anything is deleted. */
interface PlannedDelete {
  key: string;
  /** Set when this object's preconditions cannot be honoured on this bucket. */
  rejected?: S3Error;
  /** Set when this object carries preconditions still to be evaluated. */
  preconditions?: ParsedDeletePreconditions;
}

/** The `<Delete>` root, allowing the namespace attribute the SDKs put on it. */
const DELETE_ROOT_OPEN = /<Delete(\s[^>]*)?>/;

function malformedXml(): S3Error {
  return new S3Error(
    "MalformedXML",
    "The XML you provided was not well-formed or did not validate against our published schema.",
    400,
  );
}

/**
 * Reject a body that element extraction would otherwise read as a shorter, valid
 * request. Regexes see no further than the tags that happen to be closed, so a
 * truncated document quietly loses its tail: a body cut off after the first
 * `</Object>` would delete that one key and answer `200 OK` as though the batch
 * were complete. Real S3 answers MalformedXML and deletes nothing, so the tags
 * this parser relies on are checked for their closers before anything is read
 * out of them.
 */
function assertWellFormedDeleteBody(body: string): void {
  const rooted = DELETE_ROOT_OPEN.test(body) && body.includes("</Delete>");
  if (!rooted || !xmlTagsClosed(body, "Object") || !xmlTagsClosed(body, "Key")) {
    throw malformedXml();
  }
}

/**
 * Parse the objects named in a Multi-Object Delete body. Each `<Object>` entry
 * carries a key plus the optional per-object preconditions AWS added for
 * conditional deletes: `<ETag>` for every bucket type, `<LastModifiedTime>` and
 * `<Size>` for directory buckets.
 *
 * A body with no `<Object>` wrapper anywhere falls back to a bare `<Key>` scan.
 * Every AWS SDK wraps its keys, but hand-written XML that skips the wrapper used
 * to delete just fine here, and answering `200 OK` while quietly deleting nothing
 * is the worst available way to break it.
 */
function parseRequestedDeletes(body: string): RequestedDelete[] {
  assertWellFormedDeleteBody(body);
  const blocks = xmlBlocks(body, "Object");
  if (blocks.length === 0) {
    return xmlBlocks(body, "Key").map((raw) => ({
      key: unescapeXml(raw),
      preconditions: {},
    }));
  }
  return blocks.map((block) => {
    const key = xmlElement(block, "Key");
    if (key === undefined) {
      // Silently skipping the entry would report the batch as a partial success
      // with no sign an object was dropped. Real S3 answers MalformedXML.
      throw malformedXml();
    }
    return {
      key,
      preconditions: {
        ifMatch: xmlElement(block, "ETag"),
        ifMatchLastModifiedTime: xmlElement(block, "LastModifiedTime"),
        ifMatchSize: xmlElement(block, "Size"),
      },
    };
  });
}

export function deleteObjects(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const body = Buffer.isBuffer(request.body)
    ? request.body.toString("utf-8")
    : (request.body as string);

  const quiet = xmlElement(body, "Quiet")?.trim().toLowerCase() === "true";
  const requested = parseRequestedDeletes(body);

  // A missing bucket fails the whole request, before any key is looked at.
  if (!store.hasBucket(bucket)) {
    throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
  }
  const isDirectoryBucket = store.getBucketType(bucket) === "directory";

  // Settle every entry before deleting anything, so a malformed value throws out
  // of here as a request-level 400 rather than leaving the batch half applied.
  const planned: PlannedDelete[] = requested.map(({ key, preconditions }) => {
    if (!hasDeletePreconditions(preconditions)) return { key };
    if (!isDirectoryBucket) {
      const rejected = directoryOnlyPreconditionError(preconditions, "element");
      // Reported against this object alone; the rest of the batch still proceeds.
      if (rejected) return { key, rejected };
    }
    return { key, preconditions: parseDeletePreconditions(preconditions) };
  });

  const deleted: string[] = [];
  const errors: { key: string; code: string; message: string }[] = [];

  for (const entry of planned) {
    if (entry.rejected) {
      errors.push({ key: entry.key, code: entry.rejected.code, message: entry.rejected.message });
      continue;
    }
    if (entry.preconditions) {
      try {
        checkConditionalDelete(entry.preconditions, store.peekObject(bucket, entry.key));
      } catch (err) {
        // Only a per-object verdict belongs in the body. Anything else is a
        // request-level failure and must not be dressed up as a 200.
        if (!(err instanceof S3Error) || !PER_OBJECT_ERROR_CODES.has(err.code)) throw err;
        errors.push({ key: entry.key, code: err.code, message: err.message });
        continue;
      }
    }
    store.deleteObject(bucket, entry.key);
    deleted.push(entry.key);
  }

  const entries: string[] = [];
  // Quiet mode suppresses the successes but never the errors.
  if (!quiet) {
    for (const key of deleted) {
      entries.push(`<Deleted><Key>${escapeXml(key)}</Key></Deleted>`);
    }
  }
  for (const e of errors) {
    entries.push(
      `<Error><Key>${escapeXml(e.key)}</Key><Code>${escapeXml(e.code)}</Code><Message>${escapeXml(e.message)}</Message></Error>`,
    );
  }

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    entries.length ? `  ${entries.join("\n    ")}` : "",
    `</DeleteResult>`,
  ]
    .filter(Boolean)
    .join("\n");

  reply.header("content-type", "application/xml");
  reply.status(200).send(xml);
}
