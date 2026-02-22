import type { FastifyRequest, FastifyReply } from "fastify";
import type { DeletedObject } from "@aws-sdk/client-s3";
import { escapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";

function unescapeXml(str: string): string {
  return str
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

export function deleteObjects(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const body = Buffer.isBuffer(request.body)
    ? request.body.toString("utf-8")
    : (request.body as string);

  // Parse <Quiet> flag from XML body
  const quietMatch = /<Quiet>(true|false)<\/Quiet>/i.exec(body);
  const quiet = quietMatch?.[1]?.toLowerCase() === "true";

  // Parse <Key> elements from XML body with proper entity unescaping
  const keys: string[] = [];
  const keyRegex = /<Key>([\s\S]*?)<\/Key>/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(body)) !== null) {
    keys.push(unescapeXml(match[1]));
  }

  const deleted = store.deleteObjects(bucket, keys);

  let deletedXml = "";
  if (!quiet) {
    const deletedData = deleted.map((key) => ({ Key: key }) satisfies DeletedObject);
    deletedXml = deletedData
      .map((d) => `<Deleted><Key>${escapeXml(d.Key!)}</Key></Deleted>`)
      .join("\n    ");
  }

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
