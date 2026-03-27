import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";

export async function deleteBucketLifecycleConfiguration(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): Promise<void> {
  const bucket = request.params.bucket;
  if (!store.hasBucket(bucket)) {
    throw new S3Error("NoSuchBucket", "The specified bucket does not exist", 404);
  }

  await store.deleteBucketLifecycleConfiguration(bucket);
  reply.status(204).send();
}
