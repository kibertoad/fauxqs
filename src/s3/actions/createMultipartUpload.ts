import type { FastifyRequest, FastifyReply } from "fastify";
import { escapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";

function extractMetadata(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase().startsWith("x-amz-meta-") && value) {
      const metaKey = key.toLowerCase().slice("x-amz-meta-".length);
      metadata[metaKey] = Array.isArray(value) ? value[0] : value;
    }
  }
  return metadata;
}

export function createMultipartUpload(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];
  const contentType = request.headers["content-type"] ?? "application/octet-stream";
  const metadata = extractMetadata(
    request.headers as Record<string, string | string[] | undefined>,
  );

  const uploadId = store.createMultipartUpload(bucket, key, contentType, metadata);

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Bucket>${escapeXml(bucket)}</Bucket>`,
    `  <Key>${escapeXml(key)}</Key>`,
    `  <UploadId>${escapeXml(uploadId)}</UploadId>`,
    `</InitiateMultipartUploadResult>`,
  ].join("\n");

  reply.header("content-type", "application/xml");
  reply.status(200).send(xml);
}
