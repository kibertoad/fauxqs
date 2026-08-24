import type { FastifyRequest, FastifyReply } from "fastify";
import type { DeletedObject, _Error } from "@aws-sdk/client-s3";
import { S3Error } from "../../common/errors.ts";
import { escapeXml, unescapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";
import {
  type DeletePreconditions,
  checkConditionalDelete,
  hasDeletePreconditions,
  rejectDirectoryOnlyPreconditions,
} from "../conditionalDeletes.ts";

/** Body element names of the two preconditions only directory buckets accept. */
const DIRECTORY_ONLY_ELEMENTS = {
  ifMatchLastModifiedTime: "LastModifiedTime",
  ifMatchSize: "Size",
} as const;

// Non-global so each `exec` starts from the beginning of the <Object> block it
// is handed; the <Object> scan below is the only stateful one.
const ELEMENT_PATTERNS = {
  Key: /<Key>([\s\S]*?)<\/Key>/,
  ETag: /<ETag>([\s\S]*?)<\/ETag>/,
  LastModifiedTime: /<LastModifiedTime>([\s\S]*?)<\/LastModifiedTime>/,
  Size: /<Size>([\s\S]*?)<\/Size>/,
} as const;

interface RequestedDelete {
  key: string;
  preconditions: DeletePreconditions;
}

function element(block: string, name: keyof typeof ELEMENT_PATTERNS): string | undefined {
  const match = ELEMENT_PATTERNS[name].exec(block);
  return match ? unescapeXml(match[1]) : undefined;
}

/** Read a precondition element, treating an empty one as absent. */
function precondition(block: string, name: keyof typeof ELEMENT_PATTERNS): string | undefined {
  const value = element(block, name);
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * Parse the `<Object>` entries of a Multi-Object Delete body. Each entry carries
 * a key plus the optional per-object preconditions AWS added for conditional
 * deletes: `<ETag>` for every bucket type, `<LastModifiedTime>` and `<Size>` for
 * directory buckets.
 */
function parseRequestedDeletes(body: string): RequestedDelete[] {
  const requested: RequestedDelete[] = [];
  const objectRegex = /<Object>([\s\S]*?)<\/Object>/g;
  let match: RegExpExecArray | null;
  while ((match = objectRegex.exec(body)) !== null) {
    const block = match[1];
    const key = element(block, "Key");
    if (key === undefined) continue;
    requested.push({
      key,
      preconditions: {
        ifMatch: precondition(block, "ETag"),
        ifMatchLastModifiedTime: precondition(block, "LastModifiedTime"),
        ifMatchSize: precondition(block, "Size"),
      },
    });
  }
  return requested;
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

  // Parse <Quiet> flag from XML body
  const quietMatch = /<Quiet>(true|false)<\/Quiet>/i.exec(body);
  const quiet = quietMatch?.[1]?.toLowerCase() === "true";

  const requested = parseRequestedDeletes(body);

  // A missing bucket fails the whole request, before any key is looked at.
  if (!store.hasBucket(bucket)) {
    throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
  }

  // Unsupported preconditions are rejected up front so a batch is never half
  // applied before the request turns out to be invalid.
  if (store.getBucketType(bucket) !== "directory") {
    for (const { preconditions } of requested) {
      rejectDirectoryOnlyPreconditions(preconditions, DIRECTORY_ONLY_ELEMENTS, "element");
    }
  }

  const deleted: DeletedObject[] = [];
  const errors: _Error[] = [];

  for (const { key, preconditions } of requested) {
    if (hasDeletePreconditions(preconditions)) {
      try {
        checkConditionalDelete(preconditions, store.peekObject(bucket, key));
      } catch (err) {
        if (!(err instanceof S3Error)) throw err;
        // A per-object precondition failure is reported in the response body,
        // and the rest of the batch still goes through.
        errors.push({ Key: key, Code: err.code, Message: err.message });
        continue;
      }
    }
    store.deleteObject(bucket, key);
    deleted.push({ Key: key });
  }

  const entries: string[] = [];
  // Quiet mode suppresses the successes but never the errors.
  if (!quiet) {
    for (const d of deleted) {
      entries.push(`<Deleted><Key>${escapeXml(d.Key!)}</Key></Deleted>`);
    }
  }
  for (const e of errors) {
    entries.push(
      `<Error><Key>${escapeXml(e.Key!)}</Key><Code>${e.Code}</Code><Message>${escapeXml(e.Message!)}</Message></Error>`,
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
