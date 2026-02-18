import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.js";
import type { S3Store } from "../s3Store.js";

export function headBucket(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  if (!store.hasBucket(bucket)) {
    throw new S3Error("NotFound", "The specified bucket does not exist", 404);
  }
  reply.status(200).send();
}
