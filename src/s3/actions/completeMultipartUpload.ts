import type { FastifyRequest, FastifyReply } from "fastify";
import { escapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";

function unescapeXml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function completeMultipartUpload(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];
  const query = (request.query ?? {}) as Record<string, string>;
  const uploadId = query["uploadId"];

  const body = Buffer.isBuffer(request.body)
    ? request.body.toString("utf-8")
    : (request.body as string);

  // Parse <Part> elements from XML body
  const parts: { partNumber: number; etag: string }[] = [];
  const partRegex =
    /<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([\s\S]*?)<\/ETag>\s*<\/Part>/g;
  let match: RegExpExecArray | null;
  while ((match = partRegex.exec(body)) !== null) {
    parts.push({
      partNumber: parseInt(match[1], 10),
      etag: unescapeXml(match[2]),
    });
  }

  // Also handle reversed order (ETag before PartNumber)
  if (parts.length === 0) {
    const altRegex =
      /<Part>\s*<ETag>([\s\S]*?)<\/ETag>\s*<PartNumber>(\d+)<\/PartNumber>\s*<\/Part>/g;
    while ((match = altRegex.exec(body)) !== null) {
      parts.push({
        partNumber: parseInt(match[2], 10),
        etag: unescapeXml(match[1]),
      });
    }
  }

  const obj = store.completeMultipartUpload(uploadId, parts);

  const host = request.headers.host ?? "localhost";
  const location = `http://${host}/${bucket}/${key}`;

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Location>${escapeXml(location)}</Location>`,
    `  <Bucket>${escapeXml(bucket)}</Bucket>`,
    `  <Key>${escapeXml(key)}</Key>`,
    `  <ETag>${escapeXml(obj.etag)}</ETag>`,
    `</CompleteMultipartUploadResult>`,
  ].join("\n");

  reply.header("content-type", "application/xml");
  reply.status(200).send(xml);
}
