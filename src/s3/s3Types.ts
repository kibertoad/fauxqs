export interface S3Object {
  key: string;
  body: Buffer;
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified: Date;
  metadata: Record<string, string>;
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
}
