import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.ts";

export function deleteBucket(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  store.deleteBucket(bucket);
  reply.status(204).send();
}
