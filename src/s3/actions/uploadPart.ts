import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";
import { decodeAwsChunked } from "../chunkedEncoding.ts";
import { extractChecksumFromHeaders, checksumHeaderName } from "../checksum.ts";

export async function uploadPart(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): Promise<void> {
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
    const srcObj = await store.getObject(srcBucket, srcKey);

    let partBody: Buffer;
    const copyRange = request.headers["x-amz-copy-source-range"] as string | undefined;
    if (
      copyRange &&
      !store.relaxedRules?.disableMinCopySourceSize &&
      srcObj.body.length <= 5 * 1024 * 1024
    ) {
      throw new S3Error(
        "InvalidRequest",
        "The specified copy source is not supported as a byte-range copy source",
        400,
      );
    }
    if (copyRange) {
      const match = copyRange.match(/^bytes=(\d+)-(\d+)$/);
      if (!match) {
        throw new S3Error("InvalidArgument", "Invalid x-amz-copy-source-range", 400);
      }
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      if (start > end || start >= srcObj.body.length) {
        throw new S3Error(
          "InvalidArgument",
          `Range specified is not valid for source object of size: ${srcObj.body.length}`,
          400,
        );
      }
      partBody = srcObj.body.subarray(start, end + 1);
    } else {
      partBody = srcObj.body;
    }

    const result = await store.uploadPart(uploadId, partNumber, partBody);

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<CopyPartResult>`,
      `  <ETag>${result.etag}</ETag>`,
      `  <LastModified>${new Date().toISOString()}</LastModified>`,
      `</CopyPartResult>`,
    ].join("\n");

    reply.header("content-type", "application/xml");
    reply.status(200).send(xml);
    return;
  }

  let body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body as string);

  // Decode aws-chunked encoding if present
  let trailers: Record<string, string> = {};
  const contentEncoding = request.headers["content-encoding"];
  if (contentEncoding && contentEncoding.includes("aws-chunked")) {
    const decoded = decodeAwsChunked(body);
    body = decoded.body;
    trailers = decoded.trailers;
  }

  // Extract checksum from trailing headers first, then regular headers
  const cksum =
    extractChecksumFromHeaders(trailers) ??
    extractChecksumFromHeaders(request.headers as Record<string, string | string[] | undefined>);

  const result = await store.uploadPart(uploadId, partNumber, body, cksum?.value);

  reply.header("etag", result.etag);
  if (cksum && result.checksumValue) {
    reply.header(checksumHeaderName(cksum.algorithm), result.checksumValue);
  }
  reply.status(200).send();
}
