export interface S3Object {
  key: string;
  body: Buffer;
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified: Date;
}
