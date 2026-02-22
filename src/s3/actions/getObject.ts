import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";

export function getObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];

  const obj = store.getObject(bucket, key);

  // Conditional request headers (RFC 7232 precedence)
  const ifMatch = request.headers["if-match"] as string | undefined;
  const ifNoneMatch = request.headers["if-none-match"] as string | undefined;

  if (ifMatch) {
    if (ifMatch !== obj.etag) {
      throw new S3Error(
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
        412,
      );
    }
    // If-Match succeeded — skip If-Unmodified-Since per RFC 7232
  } else {
    const ifUnmodifiedSince = request.headers["if-unmodified-since"] as string | undefined;
    if (ifUnmodifiedSince) {
      const since = new Date(ifUnmodifiedSince);
      if (!isNaN(since.getTime()) && obj.lastModified > since) {
        throw new S3Error(
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
          412,
        );
      }
    }
  }

  if (ifNoneMatch) {
    if (ifNoneMatch === obj.etag) {
      reply.status(304).send();
      return;
    }
    // If-None-Match evaluated — skip If-Modified-Since per RFC 7232
  } else {
    const ifModifiedSince = request.headers["if-modified-since"] as string | undefined;
    if (ifModifiedSince) {
      const since = new Date(ifModifiedSince);
      if (!isNaN(since.getTime()) && obj.lastModified <= since) {
        reply.status(304).send();
        return;
      }
    }
  }

  reply.header("content-type", obj.contentType);
  reply.header("etag", obj.etag);
  reply.header("last-modified", obj.lastModified.toUTCString());
  for (const [metaKey, metaValue] of Object.entries(obj.metadata)) {
    reply.header(`x-amz-meta-${metaKey}`, metaValue);
  }

  // Fix 11: Range request support
  const rangeHeader = request.headers["range"] as string | undefined;
  if (rangeHeader) {
    const total = obj.body.length;
    const parsed = parseRange(rangeHeader, total);

    if (!parsed) {
      reply.header("content-range", `bytes */${total}`);
      throw new S3Error("InvalidRange", "The requested range is not satisfiable", 416);
    }

    const { start, end } = parsed;
    const sliced = obj.body.subarray(start, end + 1);
    reply.header("content-length", sliced.length);
    reply.header("content-range", `bytes ${start}-${end}/${total}`);
    reply.status(206).send(sliced);
    return;
  }

  reply.header("content-length", obj.contentLength);
  reply.status(200).send(obj.body);
}

function parseRange(rangeHeader: string, total: number): { start: number; end: number } | null {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, startStr, endStr] = match;
  let start: number;
  let end: number;

  if (startStr === "" && endStr !== "") {
    // bytes=-N → last N bytes
    const suffix = parseInt(endStr, 10);
    if (suffix === 0 || suffix > total) return null;
    start = total - suffix;
    end = total - 1;
  } else if (startStr !== "" && endStr === "") {
    // bytes=N- → from byte N to end
    start = parseInt(startStr, 10);
    if (start >= total) return null;
    end = total - 1;
  } else if (startStr !== "" && endStr !== "") {
    // bytes=N-M → byte range
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
    if (start > end || start >= total) return null;
    // Clamp end to total - 1
    if (end >= total) end = total - 1;
  } else {
    return null;
  }

  return { start, end };
}
