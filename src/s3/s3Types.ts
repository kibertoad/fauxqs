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
}

export interface MultipartPart {
  partNumber: number;
  body: Buffer;
  etag: string;
  lastModified: Date;
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
}
