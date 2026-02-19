import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.ts";

export function getObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];

  const obj = store.getObject(bucket, key);

  reply.header("content-type", obj.contentType);
  reply.header("content-length", obj.contentLength);
  reply.header("etag", obj.etag);
  reply.header("last-modified", obj.lastModified.toUTCString());
  for (const [metaKey, metaValue] of Object.entries(obj.metadata)) {
    reply.header(`x-amz-meta-${metaKey}`, metaValue);
  }
  reply.status(200).send(obj.body);
}
