/**
 * Decode AWS chunked transfer encoding.
 * Format: <hex-size>\r\n<data>\r\n ... 0\r\n<trailers>\r\n\r\n
 */
export function decodeAwsChunked(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < buf.length) {
    // Find the end of the chunk size line
    const crlfIndex = buf.indexOf("\r\n", offset);
    if (crlfIndex === -1) break;

    // The chunk size line may contain ";chunk-signature=..." — ignore everything after ";"
    const sizeLine = buf.subarray(offset, crlfIndex).toString("ascii");
    const chunkSize = parseInt(sizeLine.split(";")[0], 16);

    if (chunkSize === 0) break; // Final chunk

    const dataStart = crlfIndex + 2;
    chunks.push(buf.subarray(dataStart, dataStart + chunkSize));
    offset = dataStart + chunkSize + 2; // skip data + \r\n
  }

  return Buffer.concat(chunks);
}
