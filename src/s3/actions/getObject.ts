import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";
import { checksumHeaderName } from "../checksum.ts";

export function getObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];

  const obj = store.getObject(bucket, key);

  // partNumber support for multipart objects
  const query = (request.query ?? {}) as Record<string, string>;
  const partNumberParam = query["partNumber"];
  if (partNumberParam && obj.parts) {
    const pn = parseInt(partNumberParam, 10);
    const partInfo = obj.parts.find((p) => p.partNumber === pn);
    if (!partInfo) {
      throw new S3Error("InvalidPartNumber", "The requested partnumber is not satisfiable", 416);
    }
    const partBody = obj.body.subarray(partInfo.offset, partInfo.offset + partInfo.length);
    reply.header("content-type", obj.contentType);
    reply.header("etag", obj.etag);
    reply.header("last-modified", obj.lastModified.toUTCString());
    reply.header("x-amz-mp-parts-count", String(obj.parts.length));
    reply.header("content-length", partBody.length);
    if (obj.contentLanguage) reply.header("content-language", obj.contentLanguage);
    if (obj.contentDisposition) reply.header("content-disposition", obj.contentDisposition);
    if (obj.cacheControl) reply.header("cache-control", obj.cacheControl);
    if (obj.contentEncoding) reply.header("content-encoding", obj.contentEncoding);
    for (const [metaKey, metaValue] of Object.entries(obj.metadata)) {
      reply.header(`x-amz-meta-${metaKey}`, metaValue);
    }
    const checksumModePartNum = request.headers["x-amz-checksum-mode"] as string | undefined;
    if (
      checksumModePartNum?.toUpperCase() === "ENABLED" &&
      obj.checksumAlgorithm &&
      obj.partChecksums
    ) {
      // For partNumber requests, return the individual part's checksum
      const partIdx = obj.parts!.findIndex((p) => p.partNumber === pn);
      if (partIdx >= 0 && partIdx < obj.partChecksums.length) {
        reply.header(checksumHeaderName(obj.checksumAlgorithm), obj.partChecksums[partIdx]);
        reply.header("x-amz-checksum-type", "FULL_OBJECT");
      }
    }
    reply.status(206).send(partBody);
    return;
  }

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
  if (obj.contentLanguage) reply.header("content-language", obj.contentLanguage);
  if (obj.contentDisposition) reply.header("content-disposition", obj.contentDisposition);
  if (obj.cacheControl) reply.header("cache-control", obj.cacheControl);
  if (obj.contentEncoding) reply.header("content-encoding", obj.contentEncoding);

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

  // Checksum headers when x-amz-checksum-mode: ENABLED (only on full-object responses, not ranges)
  const checksumMode = request.headers["x-amz-checksum-mode"] as string | undefined;
  if (checksumMode?.toUpperCase() === "ENABLED" && obj.checksumAlgorithm && obj.checksumValue) {
    reply.header(checksumHeaderName(obj.checksumAlgorithm), obj.checksumValue);
    if (obj.checksumType) reply.header("x-amz-checksum-type", obj.checksumType);
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
