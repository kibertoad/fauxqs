import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";

export function getBucketLifecycleConfiguration(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  if (!store.hasBucket(bucket)) {
    throw new S3Error("NoSuchBucket", "The specified bucket does not exist", 404);
  }

  const config = store.getBucketLifecycleConfiguration(bucket);
  if (!config) {
    throw new S3Error(
      "NoSuchLifecycleConfiguration",
      "The lifecycle configuration does not exist",
      404,
    );
  }

  reply.header("content-type", "application/xml");
  reply.status(200).send(config);
}
