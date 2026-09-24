/**
 * Checksum algorithms S3 supports, in the order AWS documents them. The five
 * originals were joined by MD5, SHA512 and the three xxHash variants in
 * April 2026.
 */
export const CHECKSUM_ALGORITHMS = [
  "CRC32",
  "CRC32C",
  "CRC64NVME",
  "SHA1",
  "SHA256",
  "SHA512",
  "MD5",
  "XXHASH64",
  "XXHASH3",
  "XXHASH128",
] as const;

export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];

export interface S3Object {
  key: string;
  body: Buffer;
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified: Date;
  metadata: Record<string, string>;
  // System metadata
  contentLanguage?: string;
  contentDisposition?: string;
  cacheControl?: string;
  contentEncoding?: string;
  // Multipart part boundaries (for partNumber retrieval)
  parts?: Array<{ partNumber: number; offset: number; length: number }>;
  // Checksum
  checksumAlgorithm?: ChecksumAlgorithm;
  checksumValue?: string;
  checksumType?: "FULL_OBJECT" | "COMPOSITE";
  partChecksums?: string[];
}

export interface MultipartPart {
  partNumber: number;
  body: Buffer;
  etag: string;
  lastModified: Date;
  checksumValue?: string;
}

export interface MultipartUpload {
  uploadId: string;
  bucket: string;
  key: string;
  contentType: string;
  metadata: Record<string, string>;
  parts: Map<number, MultipartPart>;
  initiated: Date;
  // System metadata
  contentLanguage?: string;
  contentDisposition?: string;
  cacheControl?: string;
  contentEncoding?: string;
  // Checksum
  checksumAlgorithm?: ChecksumAlgorithm;
}
