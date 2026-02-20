import type { FastifyRequest, FastifyReply } from "fastify";
import type { _Object, CommonPrefix } from "@aws-sdk/client-s3";
import { escapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";

export function listObjects(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const query = (request.query ?? {}) as Record<string, string>;

  const listType = query["list-type"];
  const prefix = query["prefix"] ?? "";
  const delimiter = query["delimiter"];
  const maxKeysStr = query["max-keys"];
  const maxKeys = maxKeysStr ? parseInt(maxKeysStr, 10) : 1000;

  if (listType === "2") {
    listObjectsV2(bucket, prefix, delimiter, maxKeys, query, reply, store);
  } else {
    listObjectsV1(bucket, prefix, delimiter, maxKeys, query, reply, store);
  }
}

function listObjectsV1(
  bucket: string,
  prefix: string,
  delimiter: string | undefined,
  maxKeys: number,
  query: Record<string, string>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const marker = query["marker"] ?? "";
  const { objects, commonPrefixes, isTruncated } = store.listObjects(bucket, {
    prefix,
    delimiter,
    maxKeys,
    marker,
  });

  const contentsData = objects.map(
    (obj) =>
      ({
        Key: obj.key,
        Size: obj.contentLength,
        ETag: obj.etag,
        LastModified: obj.lastModified,
        StorageClass: "STANDARD",
      }) satisfies _Object,
  );

  const commonPrefixesData = commonPrefixes.map((p) => ({ Prefix: p }) satisfies CommonPrefix);

  const contentsXml = contentsData
    .map(
      (obj) =>
        `<Contents>` +
        `<Key>${escapeXml(obj.Key!)}</Key>` +
        `<Size>${obj.Size}</Size>` +
        `<ETag>${escapeXml(obj.ETag!)}</ETag>` +
        `<LastModified>${obj.LastModified!.toISOString()}</LastModified>` +
        `<StorageClass>${obj.StorageClass}</StorageClass>` +
        `</Contents>`,
    )
    .join("\n    ");

  const commonPrefixesXml = commonPrefixesData
    .map((p) => `<CommonPrefixes><Prefix>${escapeXml(p.Prefix!)}</Prefix></CommonPrefixes>`)
    .join("\n    ");

  const nextMarker = isTruncated && objects.length > 0 ? objects[objects.length - 1].key : "";

  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Name>${escapeXml(bucket)}</Name>`,
    `  <Prefix>${escapeXml(prefix)}</Prefix>`,
    `  <Marker>${escapeXml(marker)}</Marker>`,
    `  <MaxKeys>${maxKeys}</MaxKeys>`,
    `  <IsTruncated>${isTruncated}</IsTruncated>`,
  ];
  if (isTruncated && nextMarker) {
    parts.push(`  <NextMarker>${escapeXml(nextMarker)}</NextMarker>`);
  }
  if (delimiter) {
    parts.push(`  <Delimiter>${escapeXml(delimiter)}</Delimiter>`);
  }
  if (contentsXml) parts.push(`  ${contentsXml}`);
  if (commonPrefixesXml) parts.push(`  ${commonPrefixesXml}`);
  parts.push(`</ListBucketResult>`);

  reply.header("content-type", "application/xml");
  reply.status(200).send(parts.join("\n"));
}

function listObjectsV2(
  bucket: string,
  prefix: string,
  delimiter: string | undefined,
  maxKeys: number,
  query: Record<string, string>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const startAfter = query["start-after"] ?? "";
  const continuationToken = query["continuation-token"];
  // Use continuation-token as the start-after if provided (it encodes the last key)
  const effectiveStartAfter = continuationToken
    ? Buffer.from(continuationToken, "base64").toString("utf-8")
    : startAfter;

  const { objects, commonPrefixes, isTruncated } = store.listObjects(bucket, {
    prefix,
    delimiter,
    maxKeys,
    startAfter: effectiveStartAfter,
  });

  const keyCount = objects.length + commonPrefixes.length;

  const contentsData = objects.map(
    (obj) =>
      ({
        Key: obj.key,
        Size: obj.contentLength,
        ETag: obj.etag,
        LastModified: obj.lastModified,
        StorageClass: "STANDARD",
      }) satisfies _Object,
  );

  const commonPrefixesData = commonPrefixes.map((p) => ({ Prefix: p }) satisfies CommonPrefix);

  const contentsXml = contentsData
    .map(
      (obj) =>
        `<Contents>` +
        `<Key>${escapeXml(obj.Key!)}</Key>` +
        `<Size>${obj.Size}</Size>` +
        `<ETag>${escapeXml(obj.ETag!)}</ETag>` +
        `<LastModified>${obj.LastModified!.toISOString()}</LastModified>` +
        `<StorageClass>${obj.StorageClass}</StorageClass>` +
        `</Contents>`,
    )
    .join("\n    ");

  const commonPrefixesXml = commonPrefixesData
    .map((p) => `<CommonPrefixes><Prefix>${escapeXml(p.Prefix!)}</Prefix></CommonPrefixes>`)
    .join("\n    ");

  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Name>${escapeXml(bucket)}</Name>`,
    `  <Prefix>${escapeXml(prefix)}</Prefix>`,
    `  <KeyCount>${keyCount}</KeyCount>`,
    `  <MaxKeys>${maxKeys}</MaxKeys>`,
    `  <IsTruncated>${isTruncated}</IsTruncated>`,
  ];
  if (startAfter) {
    parts.push(`  <StartAfter>${escapeXml(startAfter)}</StartAfter>`);
  }
  if (continuationToken) {
    parts.push(`  <ContinuationToken>${escapeXml(continuationToken)}</ContinuationToken>`);
  }
  if (isTruncated && objects.length > 0) {
    const lastKey = objects[objects.length - 1].key;
    const nextToken = Buffer.from(lastKey, "utf-8").toString("base64");
    parts.push(`  <NextContinuationToken>${escapeXml(nextToken)}</NextContinuationToken>`);
  }
  if (delimiter) {
    parts.push(`  <Delimiter>${escapeXml(delimiter)}</Delimiter>`);
  }
  if (contentsXml) parts.push(`  ${contentsXml}`);
  if (commonPrefixesXml) parts.push(`  ${commonPrefixesXml}`);
  parts.push(`</ListBucketResult>`);

  reply.header("content-type", "application/xml");
  reply.status(200).send(parts.join("\n"));
}
