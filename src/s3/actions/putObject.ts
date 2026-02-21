import type { FastifyRequest, FastifyReply } from "fastify";
import type { CopyObjectOutput } from "@aws-sdk/client-s3";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";
import { decodeAwsChunked } from "../chunkedEncoding.ts";

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

export function putObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];
  const contentType = request.headers["content-type"] ?? "application/octet-stream";
  const copySource = request.headers["x-amz-copy-source"] as string | undefined;

  if (copySource) {
    // CopyObject: copy from source bucket/key
    const raw = decodeURIComponent(copySource);
    const decoded = raw.startsWith("/") ? raw.slice(1) : raw;
    const slashIdx = decoded.indexOf("/");
    if (slashIdx === -1) {
      throw new S3Error("InvalidArgument", "Invalid copy source bucket name", 400);
    }
    const srcBucket = decoded.substring(0, slashIdx);
    const srcKey = decoded.substring(slashIdx + 1);

    const srcObj = store.getObject(srcBucket, srcKey);
    const metadataDirective =
      (request.headers["x-amz-metadata-directive"] as string | undefined) ?? "COPY";
    const metadata =
      metadataDirective === "REPLACE"
        ? extractMetadata(request.headers as Record<string, string | string[] | undefined>)
        : srcObj.metadata;

    const obj = store.putObject(bucket, key, srcObj.body, srcObj.contentType, metadata);

    if (store.spy) {
      store.spy.addMessage({
        service: "s3",
        bucket,
        key,
        status: "copied",
        timestamp: Date.now(),
      });
    }

    const result = {
      CopyObjectResult: {
        ETag: obj.etag,
        LastModified: obj.lastModified,
      },
    } satisfies CopyObjectOutput;

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<CopyObjectResult>`,
      `  <ETag>${result.CopyObjectResult!.ETag}</ETag>`,
      `  <LastModified>${result.CopyObjectResult!.LastModified!.toISOString()}</LastModified>`,
      `</CopyObjectResult>`,
    ].join("\n");

    reply.header("content-type", "application/xml");
    reply.status(200).send(xml);
    return;
  }

  let body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body as string);

  // Decode aws-chunked encoding if present
  const contentEncoding = request.headers["content-encoding"];
  if (contentEncoding && contentEncoding.includes("aws-chunked")) {
    body = decodeAwsChunked(body);
  }

  const metadata = extractMetadata(
    request.headers as Record<string, string | string[] | undefined>,
  );
  const obj = store.putObject(bucket, key, body, contentType, metadata);

  reply.header("etag", obj.etag);
  reply.status(200).send();
}
