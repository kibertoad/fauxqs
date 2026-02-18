import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.js";

export function putObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];
  const contentType = request.headers["content-type"] ?? "application/octet-stream";

  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body as string);

  const obj = store.putObject(bucket, key, body, contentType);

  reply.header("etag", obj.etag);
  reply.status(200).send();
}
