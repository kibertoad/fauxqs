import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";
import { decodeAwsChunked } from "../chunkedEncoding.ts";

export function uploadPart(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const query = (request.query ?? {}) as Record<string, string>;
  const uploadId = query["uploadId"];
  const partNumber = parseInt(query["partNumber"], 10);

  // UploadPartCopy: check for x-amz-copy-source header
  const copySource = request.headers["x-amz-copy-source"] as string | undefined;
  if (copySource) {
    const raw = decodeURIComponent(copySource);
    const decoded = raw.startsWith("/") ? raw.slice(1) : raw;
    const slashIdx = decoded.indexOf("/");
    if (slashIdx === -1) {
      throw new S3Error("InvalidArgument", "Invalid copy source", 400);
    }
    const srcBucket = decoded.substring(0, slashIdx);
    const srcKey = decoded.substring(slashIdx + 1);
    const srcObj = store.getObject(srcBucket, srcKey);

    let partBody: Buffer;
    const copyRange = request.headers["x-amz-copy-source-range"] as string | undefined;
    if (copyRange) {
      const match = copyRange.match(/^bytes=(\d+)-(\d+)$/);
      if (!match) {
        throw new S3Error("InvalidArgument", "Invalid x-amz-copy-source-range", 400);
      }
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      partBody = srcObj.body.subarray(start, end + 1);
    } else {
      partBody = srcObj.body;
    }

    const etag = store.uploadPart(uploadId, partNumber, partBody);

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<CopyPartResult>`,
      `  <ETag>${etag}</ETag>`,
      `  <LastModified>${new Date().toISOString()}</LastModified>`,
      `</CopyPartResult>`,
    ].join("\n");

    reply.header("content-type", "application/xml");
    reply.status(200).send(xml);
    return;
  }

  let body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body as string);

  // Decode aws-chunked encoding if present
  const contentEncoding = request.headers["content-encoding"];
  if (contentEncoding && contentEncoding.includes("aws-chunked")) {
    body = decodeAwsChunked(body);
  }

  const etag = store.uploadPart(uploadId, partNumber, body);

  reply.header("etag", etag);
  reply.status(200).send();
}
