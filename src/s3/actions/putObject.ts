import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.ts";

/**
 * Decode AWS chunked transfer encoding.
 * Format: <hex-size>\r\n<data>\r\n ... 0\r\n<trailers>\r\n\r\n
 */
function decodeAwsChunked(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < buf.length) {
    // Find the end of the chunk size line
    const crlfIndex = buf.indexOf("\r\n", offset);
    if (crlfIndex === -1) break;

    // The chunk size line may contain ";chunk-signature=..." — ignore everything after ";"
    const sizeLine = buf.subarray(offset, crlfIndex).toString("ascii");
    const chunkSize = parseInt(sizeLine.split(";")[0], 16);

    if (chunkSize === 0) break; // Final chunk

    const dataStart = crlfIndex + 2;
    chunks.push(buf.subarray(dataStart, dataStart + chunkSize));
    offset = dataStart + chunkSize + 2; // skip data + \r\n
  }

  return Buffer.concat(chunks);
}

function extractMetadata(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase().startsWith("x-amz-meta-") && value) {
      const metaKey = key.toLowerCase().slice("x-amz-meta-".length);
      metadata[metaKey] = Array.isArray(value) ? value[0] : value;
    }
  }
  return metadata;
}

export function putObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];
  const contentType = request.headers["content-type"] ?? "application/octet-stream";
  const copySource = request.headers["x-amz-copy-source"] as string | undefined;

  if (copySource) {
    // CopyObject: copy from source bucket/key
    const decoded = decodeURIComponent(copySource).replace(/^\//, "");
    const slashIdx = decoded.indexOf("/");
    if (slashIdx === -1) {
      reply.status(400).send();
      return;
    }
    const srcBucket = decoded.substring(0, slashIdx);
    const srcKey = decoded.substring(slashIdx + 1);

    const srcObj = store.getObject(srcBucket, srcKey);
    const metadata = extractMetadata(request.headers as Record<string, string | string[] | undefined>);
    const hasMetadata = Object.keys(metadata).length > 0;

    const obj = store.putObject(bucket, key, srcObj.body, srcObj.contentType, hasMetadata ? metadata : srcObj.metadata);

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<CopyObjectResult>`,
      `  <ETag>${obj.etag}</ETag>`,
      `  <LastModified>${obj.lastModified.toISOString()}</LastModified>`,
      `</CopyObjectResult>`,
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

  const metadata = extractMetadata(request.headers as Record<string, string | string[] | undefined>);
  const obj = store.putObject(bucket, key, body, contentType, metadata);

  reply.header("etag", obj.etag);
  reply.status(200).send();
}
