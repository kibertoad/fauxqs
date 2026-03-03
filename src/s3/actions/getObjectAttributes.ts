import type { FastifyRequest, FastifyReply } from "fastify";
import type { S3Store } from "../s3Store.ts";

export function getObjectAttributes(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];

  const obj = store.headObject(bucket, key);

  const requestedAttrs = ((request.headers["x-amz-object-attributes"] as string) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const requested = new Set(requestedAttrs);

  const parts: string[] = [];
  parts.push('<GetObjectAttributesResponse xmlns="http://s3.amazonaws.com/doc/2006-03-01/">');

  if (requested.has("ETag")) {
    // AWS returns unquoted ETags in GetObjectAttributes
    const unquoted = obj.etag.replaceAll('"', "");
    parts.push(`  <ETag>${unquoted}</ETag>`);
  }

  if (requested.has("StorageClass")) {
    parts.push("  <StorageClass>STANDARD</StorageClass>");
  }

  if (requested.has("ObjectSize")) {
    parts.push(`  <ObjectSize>${obj.contentLength}</ObjectSize>`);
  }

  if (requested.has("Checksum") && obj.checksumAlgorithm && obj.checksumValue) {
    const tag = `Checksum${obj.checksumAlgorithm}`;
    parts.push("  <Checksum>");
    parts.push(`    <${tag}>${obj.checksumValue}</${tag}>`);
    if (obj.checksumType) {
      parts.push(`    <ChecksumType>${obj.checksumType}</ChecksumType>`);
    }
    parts.push("  </Checksum>");
  }

  if (requested.has("ObjectParts") && obj.parts) {
    const maxParts = parseInt((request.headers["x-amz-max-parts"] as string) ?? "1000", 10);
    const partNumberMarker = parseInt(
      (request.headers["x-amz-part-number-marker"] as string) ?? "0",
      10,
    );

    const filtered = obj.parts.filter((p) => p.partNumber > partNumberMarker);
    const truncated = filtered.length > maxParts;
    const paginated = filtered.slice(0, maxParts);

    parts.push("  <ObjectParts>");
    parts.push(`    <PartsCount>${obj.parts.length}</PartsCount>`);
    parts.push(`    <IsTruncated>${truncated}</IsTruncated>`);
    parts.push(`    <MaxParts>${maxParts}</MaxParts>`);
    parts.push(`    <PartNumberMarker>${partNumberMarker}</PartNumberMarker>`);
    const nextMarker = paginated.length > 0 ? paginated[paginated.length - 1].partNumber : 0;
    parts.push(`    <NextPartNumberMarker>${nextMarker}</NextPartNumberMarker>`);
    for (let i = 0; i < paginated.length; i++) {
      const p = paginated[i];
      // partChecksums are indexed by original part order (0-based starting from partNumberMarker offset)
      const partIdx = obj.parts!.indexOf(p);
      parts.push("    <Part>");
      parts.push(`      <PartNumber>${p.partNumber}</PartNumber>`);
      parts.push(`      <Size>${p.length}</Size>`);
      if (
        obj.checksumAlgorithm &&
        obj.partChecksums &&
        partIdx >= 0 &&
        partIdx < obj.partChecksums.length
      ) {
        const tag = `Checksum${obj.checksumAlgorithm}`;
        parts.push(`      <${tag}>${obj.partChecksums[partIdx]}</${tag}>`);
      }
      parts.push("    </Part>");
    }
    parts.push("  </ObjectParts>");
  }

  parts.push("</GetObjectAttributesResponse>");

  reply.header("content-type", "application/xml");
  reply.header("last-modified", obj.lastModified.toUTCString());
  reply.status(200).send(parts.join("\n"));
}
