import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.ts";

export async function deleteObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): Promise<void> {
  const bucket = request.params.bucket;
  const key = request.params["*"];
  await store.deleteObject(bucket, key);
  reply.status(204).send();
}
