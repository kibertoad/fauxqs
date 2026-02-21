import type { FastifyRequest, FastifyReply } from "fastify";
import type { CompleteMultipartUploadOutput } from "@aws-sdk/client-s3";
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

  const result = {
    Location: location,
    Bucket: bucket,
    Key: key,
    ETag: obj.etag,
  } satisfies CompleteMultipartUploadOutput;

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Location>${escapeXml(result.Location!)}</Location>`,
    `  <Bucket>${escapeXml(result.Bucket!)}</Bucket>`,
    `  <Key>${escapeXml(result.Key!)}</Key>`,
    `  <ETag>${escapeXml(result.ETag!)}</ETag>`,
    `</CompleteMultipartUploadResult>`,
  ].join("\n");

  reply.header("content-type", "application/xml");
  reply.status(200).send(xml);
}
