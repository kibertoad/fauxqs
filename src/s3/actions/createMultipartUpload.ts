import type { FastifyRequest, FastifyReply } from "fastify";
import type { CreateMultipartUploadOutput } from "@aws-sdk/client-s3";
import { escapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";
import type { ChecksumAlgorithm } from "../s3Types.ts";

const SUPPORTED_CHECKSUM_ALGORITHMS = new Set(["CRC32", "SHA1", "SHA256"]);

function extractMetadata(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase().startsWith("x-amz-meta-") && value) {
      const metaKey = key.toLowerCase().slice("x-amz-meta-".length);
      metadata[metaKey] = Array.isArray(value) ? value[0] : value;
    }
  }
  return metadata;
}

function extractSystemMetadata(headers: Record<string, string | string[] | undefined>): {
  contentLanguage?: string;
  contentDisposition?: string;
  cacheControl?: string;
  contentEncoding?: string;
} {
  const result: Record<string, string> = {};
  const h = (name: string) => {
    const v = headers[name];
    return typeof v === "string" ? v : undefined;
  };
  const cl = h("content-language");
  if (cl) result.contentLanguage = cl;
  const cd = h("content-disposition");
  if (cd) result.contentDisposition = cd;
  const cc = h("cache-control");
  if (cc) result.cacheControl = cc;
  const ce = h("content-encoding");
  if (ce && !ce.includes("aws-chunked")) result.contentEncoding = ce;
  return result;
}

export async function createMultipartUpload(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): Promise<void> {
  const bucket = request.params.bucket;
  const key = request.params["*"];
  const contentType = request.headers["content-type"] ?? "application/octet-stream";
  const metadata = extractMetadata(
    request.headers as Record<string, string | string[] | undefined>,
  );

  const systemMeta = extractSystemMetadata(
    request.headers as Record<string, string | string[] | undefined>,
  );
  const checksumAlgoHeader = (
    request.headers["x-amz-checksum-algorithm"] as string | undefined
  )?.toUpperCase();
  const checksumAlgorithm =
    checksumAlgoHeader && SUPPORTED_CHECKSUM_ALGORITHMS.has(checksumAlgoHeader)
      ? (checksumAlgoHeader as ChecksumAlgorithm)
      : undefined;
  const uploadId = await store.createMultipartUpload(
    bucket,
    key,
    contentType,
    metadata,
    systemMeta,
    checksumAlgorithm,
  );

  const result = {
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  } satisfies CreateMultipartUploadOutput;

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Bucket>${escapeXml(result.Bucket!)}</Bucket>`,
    `  <Key>${escapeXml(result.Key!)}</Key>`,
    `  <UploadId>${escapeXml(result.UploadId!)}</UploadId>`,
    `</InitiateMultipartUploadResult>`,
  ].join("\n");

  reply.header("content-type", "application/xml");
  if (checksumAlgorithm) {
    reply.header("x-amz-checksum-algorithm", checksumAlgorithm);
  }
  reply.status(200).send(xml);
}
