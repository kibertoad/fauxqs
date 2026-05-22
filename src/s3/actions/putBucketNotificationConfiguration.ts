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

  // The regex-based parser silently treats non-XML or truncated payloads as an
  // empty configuration. Real S3 rejects those with MalformedXML, so require a
  // well-formed <NotificationConfiguration> root element before parsing.
  const trimmedBody = bodyStr.trim();
  const hasRootElement =
    trimmedBody.includes("<NotificationConfiguration") &&
    (trimmedBody.includes("</NotificationConfiguration>") ||
      /<NotificationConfiguration[^>]*\/>/.test(trimmedBody));
  if (!hasRootElement) {
    throw new S3Error(
      "MalformedXML",
      "The XML you provided was not well-formed or did not validate against our published schema.",
      400,
    );
  }

  store.putBucketNotificationConfiguration(bucket, parseNotificationConfigXml(bodyStr));
  reply.status(200).send();
}
