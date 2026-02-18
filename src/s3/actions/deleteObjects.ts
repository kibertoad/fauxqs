import type { FastifyRequest, FastifyReply } from "fastify";
import { escapeXml } from "../../common/xml.js";
import type { S3Store } from "../s3Store.js";

export function deleteObjects(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const body = Buffer.isBuffer(request.body)
    ? request.body.toString("utf-8")
    : (request.body as string);

  // Parse <Key> elements from XML body
  const keys: string[] = [];
  const keyRegex = /<Key>([^<]+)<\/Key>/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(body)) !== null) {
    keys.push(match[1]);
  }

  const deleted = store.deleteObjects(bucket, keys);

  const deletedXml = deleted
    .map((key) => `<Deleted><Key>${escapeXml(key)}</Key></Deleted>`)
    .join("\n    ");

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    deletedXml ? `  ${deletedXml}` : "",
    `</DeleteResult>`,
  ]
    .filter(Boolean)
    .join("\n");

  reply.header("content-type", "application/xml");
  reply.status(200).send(xml);
}
