import type { FastifyRequest, FastifyReply } from "fastify";
import type { CompleteMultipartUploadOutput } from "@aws-sdk/client-s3";
import { escapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";
import { checksumHeaderName } from "../checksum.ts";

function unescapeXml(str: string): string {
  return str
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

export async function completeMultipartUpload(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): Promise<void> {
  const bucket = request.params.bucket;
  const key = request.params["*"];
  const query = (request.query ?? {}) as Record<string, string>;
  const uploadId = query["uploadId"];

  const body = Buffer.isBuffer(request.body)
    ? request.body.toString("utf-8")
    : (request.body as string);

  // Parse <Part> elements from XML body
  // Extract each <Part>...</Part> block, then find PartNumber and ETag within it
  // (order varies, and optional elements like ChecksumCRC32 may appear between them)
  const parts: { partNumber: number; etag: string }[] = [];
  const partBlockRegex = /<Part>([\s\S]*?)<\/Part>/g;
  let match: RegExpExecArray | null;
  while ((match = partBlockRegex.exec(body)) !== null) {
    const block = match[1];
    const pnMatch = block.match(/<PartNumber>(\d+)<\/PartNumber>/);
    const etagMatch = block.match(/<ETag>([\s\S]*?)<\/ETag>/);
    if (pnMatch && etagMatch) {
      parts.push({
        partNumber: parseInt(pnMatch[1], 10),
        etag: unescapeXml(etagMatch[1]),
      });
    }
  }

  const obj = await store.completeMultipartUpload(uploadId, parts);

  const host = request.headers.host ?? "localhost";
  const location = `http://${host}/${bucket}/${key}`;

  const result = {
    Location: location,
    Bucket: bucket,
    Key: key,
    ETag: obj.etag,
  } satisfies CompleteMultipartUploadOutput;

  const xmlParts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Location>${escapeXml(result.Location!)}</Location>`,
    `  <Bucket>${escapeXml(result.Bucket!)}</Bucket>`,
    `  <Key>${escapeXml(result.Key!)}</Key>`,
    `  <ETag>${escapeXml(result.ETag!)}</ETag>`,
  ];

  if (obj.checksumAlgorithm && obj.checksumValue) {
    const tag = `Checksum${obj.checksumAlgorithm}`;
    xmlParts.push(`  <${tag}>${obj.checksumValue}</${tag}>`);
    if (obj.checksumType) {
      xmlParts.push(`  <ChecksumType>${obj.checksumType}</ChecksumType>`);
    }
  }

  xmlParts.push(`</CompleteMultipartUploadResult>`);
  const xml = xmlParts.join("\n");

  reply.header("content-type", "application/xml");
  if (obj.checksumAlgorithm && obj.checksumValue) {
    reply.header(checksumHeaderName(obj.checksumAlgorithm), obj.checksumValue);
  }
  reply.status(200).send(xml);
}
