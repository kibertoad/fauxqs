/**
 * Decode AWS chunked transfer encoding.
 * Format: <hex-size>;chunk-signature=...\r\n<data>\r\n ... 0\r\n<trailers>\r\n\r\n
 *
 * Returns the decoded body and any trailing headers (e.g. checksum headers).
 */
export function decodeAwsChunked(buf: Buffer): { body: Buffer; trailers: Record<string, string> } {
  const chunks: Buffer[] = [];
  let offset = 0;
  let terminalChunkEnd = buf.length;

  while (offset < buf.length) {
    // Find the end of the chunk size line
    const crlfIndex = buf.indexOf("\r\n", offset);
    if (crlfIndex === -1) break;

    // The chunk size line may contain ";chunk-signature=..." — ignore everything after ";"
    const sizeLine = buf.subarray(offset, crlfIndex).toString("ascii");
    const chunkSize = parseInt(sizeLine.split(";")[0], 16);

    if (chunkSize === 0) {
      terminalChunkEnd = crlfIndex + 2; // past the "0\r\n"
      break;
    }

    const dataStart = crlfIndex + 2;
    chunks.push(buf.subarray(dataStart, dataStart + chunkSize));
    offset = dataStart + chunkSize + 2; // skip data + \r\n
  }

  // Parse trailing headers after the terminal chunk
  const trailers: Record<string, string> = {};
  if (terminalChunkEnd < buf.length) {
    const trailerBuf = buf.subarray(terminalChunkEnd);
    const trailerStr = trailerBuf.toString("ascii");
    const lines = trailerStr.split("\r\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const name = line.substring(0, colonIdx).trim().toLowerCase();
      const value = line.substring(colonIdx + 1).trim();
      if (name) trailers[name] = value;
    }
  }

  return { body: Buffer.concat(chunks), trailers };
}
