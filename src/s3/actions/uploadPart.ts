import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.ts";

export function uploadPart(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const query = (request.query ?? {}) as Record<string, string>;
  const uploadId = query["uploadId"];
  const partNumber = parseInt(query["partNumber"], 10);

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

function decodeAwsChunked(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const crlfIndex = buf.indexOf("\r\n", offset);
    if (crlfIndex === -1) break;

    const sizeLine = buf.subarray(offset, crlfIndex).toString("ascii");
    const chunkSize = parseInt(sizeLine.split(";")[0], 16);

    if (chunkSize === 0) break;

    const dataStart = crlfIndex + 2;
    chunks.push(buf.subarray(dataStart, dataStart + chunkSize));
    offset = dataStart + chunkSize + 2;
  }

  return Buffer.concat(chunks);
}
