import type { FastifyRequest, FastifyReply } from "fastify";
import type { CopyObjectOutput } from "@aws-sdk/client-s3";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";
import type { ChecksumAlgorithm } from "../s3Types.ts";
import { decodeAwsChunked } from "../chunkedEncoding.ts";
import {
  checksumHeaderName,
  computeChecksum,
  extractChecksumFromHeaders,
  requestedChecksumAlgorithm,
  resolveUploadChecksum,
  validateChecksum,
  validateContentMd5,
} from "../checksum.ts";
import { checkConditionalWrite } from "../conditionalWrites.ts";

interface ChecksumData {
  algorithm: ChecksumAlgorithm;
  value: string;
  type: "FULL_OBJECT" | "COMPOSITE";
  partChecksums?: string[];
}

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

/**
 * Resolve the destination bucket before anything that inspects the body. Real
 * S3 answers NoSuchBucket first; deferring it to store.putObject would let a
 * checksum or precondition failure mask a typo'd bucket name.
 */
function requireBucket(store: S3Store, bucket: string): void {
  if (!store.hasBucket(bucket)) {
    throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
  }
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
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const validateChecksums = !store.relaxedRules?.disableChecksumValidation;

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
    const metadata = metadataDirective === "REPLACE" ? extractMetadata(headers) : srcObj.metadata;

    const destContentType = metadataDirective === "REPLACE" ? contentType : srcObj.contentType;
    const systemMeta =
      metadataDirective === "REPLACE"
        ? extractSystemMetadata(headers)
        : {
            ...(srcObj.contentLanguage && { contentLanguage: srcObj.contentLanguage }),
            ...(srcObj.contentDisposition && { contentDisposition: srcObj.contentDisposition }),
            ...(srcObj.cacheControl && { cacheControl: srcObj.cacheControl }),
            ...(srcObj.contentEncoding && { contentEncoding: srcObj.contentEncoding }),
          };

    requireBucket(store, bucket);

    // Conditional write (If-None-Match / If-Match) against the destination key.
    checkConditionalWrite(headers, store.peekObject(bucket, key));

    // Checksum, in the order real S3 resolves it: an explicit value on a
    // REPLACE, else an algorithm the client asked S3 to compute, else the
    // source object's own checksum (COPY only).
    let checksumData: ChecksumData | undefined;
    const supplied =
      metadataDirective === "REPLACE" ? extractChecksumFromHeaders(headers) : undefined;
    const requested = requestedChecksumAlgorithm(headers);
    if (supplied) {
      if (validateChecksums) {
        validateChecksum(supplied.algorithm, supplied.value, srcObj.body);
      }
      checksumData = { algorithm: supplied.algorithm, value: supplied.value, type: "FULL_OBJECT" };
    } else if (requested) {
      checksumData = {
        algorithm: requested,
        value: computeChecksum(requested, srcObj.body),
        type: "FULL_OBJECT",
      };
    } else if (
      metadataDirective !== "REPLACE" &&
      srcObj.checksumAlgorithm &&
      srcObj.checksumValue &&
      srcObj.checksumType
    ) {
      checksumData = {
        algorithm: srcObj.checksumAlgorithm,
        value: srcObj.checksumValue,
        type: srcObj.checksumType,
        ...(srcObj.partChecksums && { partChecksums: srcObj.partChecksums }),
      };
    }

    const obj = store.putObject(
      bucket,
      key,
      srcObj.body,
      destContentType,
      metadata,
      systemMeta,
      checksumData,
      "Copy",
    );

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
      // Real S3 reports the destination checksum inside CopyObjectResult.
      ...(obj.checksumAlgorithm && obj.checksumValue
        ? [
            `  <Checksum${obj.checksumAlgorithm}>${obj.checksumValue}</Checksum${obj.checksumAlgorithm}>`,
            `  <ChecksumType>${obj.checksumType ?? "FULL_OBJECT"}</ChecksumType>`,
          ]
        : []),
      `</CopyObjectResult>`,
    ].join("\n");

    reply.header("content-type", "application/xml");
    reply.status(200).send(xml);
    return;
  }

  let body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body as string);

  // Decode aws-chunked encoding if present
  let trailers: Record<string, string> = {};
  const contentEncoding = request.headers["content-encoding"];
  if (contentEncoding && contentEncoding.includes("aws-chunked")) {
    const decoded = decodeAwsChunked(body);
    body = decoded.body;
    trailers = decoded.trailers;
  }

  const metadata = extractMetadata(headers);
  const systemMeta = extractSystemMetadata(headers);

  requireBucket(store, bucket);

  // Conditional write (If-None-Match / If-Match) against the destination key.
  checkConditionalWrite(headers, store.peekObject(bucket, key));

  if (validateChecksums) {
    validateContentMd5(headers, body);
  }
  // Trailing headers first, then regular headers, then the algorithm-only form.
  const cksum = resolveUploadChecksum(headers, trailers, body, validateChecksums);
  const checksumData = cksum
    ? { algorithm: cksum.algorithm, value: cksum.value, type: "FULL_OBJECT" as const }
    : undefined;

  const obj = store.putObject(bucket, key, body, contentType, metadata, systemMeta, checksumData);

  reply.header("etag", obj.etag);
  if (obj.checksumAlgorithm && obj.checksumValue) {
    reply.header(checksumHeaderName(obj.checksumAlgorithm), obj.checksumValue);
    if (obj.checksumType) reply.header("x-amz-checksum-type", obj.checksumType);
  }
  reply.status(200).send();
}
