import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.ts";
import { checksumHeaderName } from "../checksum.ts";

export function headObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];

  const obj = store.headObject(bucket, key);

  reply.header("content-type", obj.contentType);
  reply.header("content-length", obj.contentLength);
  reply.header("etag", obj.etag);
  reply.header("last-modified", obj.lastModified.toUTCString());
  for (const [metaKey, metaValue] of Object.entries(obj.metadata)) {
    reply.header(`x-amz-meta-${metaKey}`, metaValue);
  }
  if (obj.contentLanguage) reply.header("content-language", obj.contentLanguage);
  if (obj.contentDisposition) reply.header("content-disposition", obj.contentDisposition);
  if (obj.cacheControl) reply.header("cache-control", obj.cacheControl);
  if (obj.contentEncoding) reply.header("content-encoding", obj.contentEncoding);
  if (obj.parts) reply.header("x-amz-mp-parts-count", String(obj.parts.length));
  const checksumMode = request.headers["x-amz-checksum-mode"] as string | undefined;
  if (checksumMode?.toUpperCase() === "ENABLED" && obj.checksumAlgorithm && obj.checksumValue) {
    reply.header(checksumHeaderName(obj.checksumAlgorithm), obj.checksumValue);
    if (obj.checksumType) reply.header("x-amz-checksum-type", obj.checksumType);
  }
  reply.status(200).send();
}
