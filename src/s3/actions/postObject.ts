import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";

/**
 * Handles S3 POST Object (presigned POST form data uploads).
 * See: https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectPOST.html
 *
 * The client sends multipart/form-data with policy fields and a file.
 * The "file" field MUST be the last field; any fields after it are ignored.
 * The object key is specified in the "key" form field, not in the URL.
 */
export function postObject(
  request: FastifyRequest<{ Params: { bucket: string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const contentType = request.headers["content-type"] ?? "";
  const boundaryMatch = /boundary=([^\s;]+)/i.exec(contentType);
  if (!boundaryMatch) {
    throw new S3Error(
      "MalformedPOSTRequest",
      "The body of your POST request is not well-formed multipart/form-data.",
      400,
    );
  }

  const boundary = boundaryMatch[1];
  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body as string);
  const { fields, file, filename } = parseMultipart(body, boundary);

  // "key" is a required field
  let key = fields["key"];
  if (!key) {
    throw new S3Error("InvalidArgument", "Bucket POST must contain a field named 'key'.", 400);
  }

  // ${filename} substitution in the key field
  if (key.includes("${filename}")) {
    const resolvedFilename = filename ?? "";
    key = key.replaceAll("${filename}", resolvedFilename);
  }

  // Content-Type for the stored object comes from the form field, default binary/octet-stream
  const objectContentType = fields["Content-Type"] ?? "binary/octet-stream";
  const fileBody = file ?? Buffer.alloc(0);

  // Extract user metadata from x-amz-meta-* form fields
  const metadata: Record<string, string> = {};
  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    if (fieldName.toLowerCase().startsWith("x-amz-meta-")) {
      const metaKey = fieldName.toLowerCase().slice("x-amz-meta-".length);
      metadata[metaKey] = fieldValue;
    }
  }

  // System metadata from form fields
  const systemMetadata: {
    contentDisposition?: string;
    cacheControl?: string;
    contentEncoding?: string;
  } = {};
  if (fields["Content-Disposition"])
    systemMetadata.contentDisposition = fields["Content-Disposition"];
  if (fields["Cache-Control"]) systemMetadata.cacheControl = fields["Cache-Control"];
  if (fields["Content-Encoding"]) systemMetadata.contentEncoding = fields["Content-Encoding"];

  const obj = store.putObject(bucket, key, fileBody, objectContentType, metadata, systemMetadata);

  if (store.spy) {
    store.spy.addMessage({
      service: "s3",
      bucket,
      key,
      status: "uploaded",
      timestamp: Date.now(),
    });
  }

  // success_action_redirect takes precedence over success_action_status
  const redirect = fields["success_action_redirect"] ?? fields["redirect"];
  if (redirect) {
    try {
      const redirectUrl = new URL(redirect);
      redirectUrl.searchParams.set("bucket", bucket);
      redirectUrl.searchParams.set("key", key);
      redirectUrl.searchParams.set("etag", obj.etag);
      reply.header("location", redirectUrl.toString());
      reply.status(303).send();
      return;
    } catch {
      // Invalid redirect URL — fall through to success_action_status
    }
  }

  // success_action_status: 200, 201, or 204 (default). Invalid values fall back to 204.
  const rawStatus = Number.parseInt(fields["success_action_status"] ?? "204", 10);
  const status = [200, 201, 204].includes(rawStatus) ? rawStatus : 204;

  // ETag header on all success responses
  reply.header("etag", obj.etag);

  if (status === 201) {
    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<PostResponse>`,
      `  <Bucket>${bucket}</Bucket>`,
      `  <Key>${key}</Key>`,
      `  <ETag>${obj.etag}</ETag>`,
      `</PostResponse>`,
    ].join("\n");
    reply.header("content-type", "application/xml");
    reply.status(201).send(xml);
  } else {
    reply.status(status).send();
  }
}

/**
 * Checks if a POST /:bucket request is a PostObject (multipart/form-data)
 * vs DeleteObjects (XML body). This is used by the router to dispatch correctly.
 */
export function isPostObjectRequest(contentType: string | undefined): boolean {
  return !!contentType && contentType.toLowerCase().includes("multipart/form-data");
}

/**
 * Parse multipart/form-data from raw buffer.
 *
 * Per the S3 spec, the "file" field must be the last field.
 * Any fields appearing after "file" are ignored.
 */
function parseMultipart(
  body: Buffer,
  boundary: string,
): { fields: Record<string, string>; file?: Buffer; filename?: string } {
  const fields: Record<string, string> = {};
  let file: Buffer | undefined;
  let filename: string | undefined;

  const delimiter = Buffer.from(`--${boundary}`);
  const crlfCrlf = Buffer.from("\r\n\r\n");
  const crlf = Buffer.from("\r\n");

  // Find all boundary positions
  const positions: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = body.indexOf(delimiter, searchFrom);
    if (idx === -1) break;
    positions.push(idx);
    searchFrom = idx + delimiter.length;
  }

  for (let i = 0; i < positions.length - 1; i++) {
    const partStart = positions[i] + delimiter.length;
    const partEnd = positions[i + 1];

    // Skip the \r\n after the boundary delimiter
    const contentStart = body.indexOf(crlf, partStart);
    if (contentStart === -1 || contentStart >= partEnd) continue;
    const headersStart = contentStart + crlf.length;

    // Find \r\n\r\n that separates headers from body
    const headerEnd = body.indexOf(crlfCrlf, headersStart);
    if (headerEnd === -1 || headerEnd >= partEnd) continue;

    const headerSection = body.subarray(headersStart, headerEnd).toString("utf-8");
    const valueStart = headerEnd + crlfCrlf.length;

    // Value ends at \r\n before the next boundary
    let valueEnd = partEnd;
    if (body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
      valueEnd = partEnd - 2; // strip trailing \r\n before boundary
    }

    // Parse Content-Disposition
    const dispositionMatch =
      /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(
        headerSection,
      );
    if (!dispositionMatch) continue;

    const fieldName = dispositionMatch[1];
    const filenamePart = dispositionMatch[2];

    if (filenamePart !== undefined || fieldName === "file") {
      // File field — extract binary data directly from buffer
      file = body.subarray(valueStart, valueEnd);
      // Extract just the filename (strip path components per AWS spec)
      if (filenamePart !== undefined) {
        const lastSlash = Math.max(filenamePart.lastIndexOf("/"), filenamePart.lastIndexOf("\\"));
        filename = lastSlash >= 0 ? filenamePart.substring(lastSlash + 1) : filenamePart;
      }
      // Per AWS spec, file must be the last field — stop processing
      break;
    }

    fields[fieldName] = body.subarray(valueStart, valueEnd).toString("utf-8");
  }

  return { fields, file, filename };
}
