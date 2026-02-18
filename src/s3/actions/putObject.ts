import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.js";

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

export function putObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];
  const contentType = request.headers["content-type"] ?? "application/octet-stream";

  let body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body as string);

  // Decode aws-chunked encoding if present
  const contentEncoding = request.headers["content-encoding"];
  if (contentEncoding && contentEncoding.includes("aws-chunked")) {
    body = decodeAwsChunked(body);
  }

  const obj = store.putObject(bucket, key, body, contentType);

  reply.header("etag", obj.etag);
  reply.status(200).send();
}
