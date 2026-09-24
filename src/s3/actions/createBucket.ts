import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.ts";
import type { BucketType } from "../s3Store.ts";

export async function createBucket(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): Promise<void> {
  const bucket = request.params.bucket;
  let bucketType: BucketType | undefined;

  // Parse optional CreateBucketConfiguration XML body for bucket type
  if (request.body) {
    const bodyStr = Buffer.isBuffer(request.body)
      ? request.body.toString("utf8")
      : String(request.body);
    if (bodyStr.includes("<Type>Directory</Type>")) {
      bucketType = "directory";
    }
  }

  await store.createBucket(bucket, bucketType);
  reply.header("location", `/${bucket}`);
  reply.status(200).send();
}
