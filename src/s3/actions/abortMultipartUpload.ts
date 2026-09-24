import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.ts";

export async function abortMultipartUpload(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): Promise<void> {
  const query = (request.query ?? {}) as Record<string, string>;
  const uploadId = query["uploadId"];

  await store.abortMultipartUpload(uploadId);

  reply.status(204).send();
}
