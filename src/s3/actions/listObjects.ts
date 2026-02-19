import type { FastifyRequest, FastifyReply } from "fastify";
import { escapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";

export function listObjects(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const objects = store.listObjects(bucket);

  const contents = objects
    .map(
      (obj) =>
        `<Contents>` +
        `<Key>${escapeXml(obj.key)}</Key>` +
        `<Size>${obj.contentLength}</Size>` +
        `<ETag>${escapeXml(obj.etag)}</ETag>` +
        `<LastModified>${obj.lastModified.toISOString()}</LastModified>` +
        `</Contents>`,
    )
    .join("\n    ");

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Name>${escapeXml(bucket)}</Name>`,
    `  <IsTruncated>false</IsTruncated>`,
    contents ? `  ${contents}` : "",
    `</ListBucketResult>`,
  ]
    .filter(Boolean)
    .join("\n");

  reply.header("content-type", "application/xml");
  reply.status(200).send(xml);
}
