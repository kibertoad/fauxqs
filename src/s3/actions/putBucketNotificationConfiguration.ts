import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";
import { parseNotificationConfigXml } from "../notifications.ts";

export function putBucketNotificationConfiguration(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  if (!store.hasBucket(bucket)) {
    throw new S3Error("NoSuchBucket", "The specified bucket does not exist", 404);
  }

  const bodyStr = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : String(request.body ?? "");

  store.putBucketNotificationConfiguration(bucket, parseNotificationConfigXml(bodyStr));
  reply.status(200).send();
}
