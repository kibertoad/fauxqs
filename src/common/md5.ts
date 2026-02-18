import { createHash } from "node:crypto";

export function md5(input: string): string {
  return createHash("md5").update(input, "utf-8").digest("hex");
}

export interface MessageAttributeForMd5 {
  DataType: string;
  StringValue?: string;
  BinaryValue?: string;
}

export function md5OfMessageAttributes(
  attributes: Record<string, MessageAttributeForMd5>,
): string {
  const names = Object.keys(attributes).sort();
  if (names.length === 0) return "";

  const buffers: Buffer[] = [];

  for (const name of names) {
    const attr = attributes[name];
    const nameBytes = Buffer.from(name, "utf-8");
    const dataTypeBytes = Buffer.from(attr.DataType, "utf-8");

    // Name: 4-byte length (big-endian) + UTF-8 bytes
    const nameLenBuf = Buffer.alloc(4);
    nameLenBuf.writeUInt32BE(nameBytes.length);
    buffers.push(nameLenBuf, nameBytes);

    // Data type: 4-byte length (big-endian) + UTF-8 bytes
    const dtLenBuf = Buffer.alloc(4);
    dtLenBuf.writeUInt32BE(dataTypeBytes.length);
    buffers.push(dtLenBuf, dataTypeBytes);

    // Transport type + value
    if (attr.DataType.startsWith("String") || attr.DataType.startsWith("Number")) {
      buffers.push(Buffer.from([1]));
      const valueBytes = Buffer.from(attr.StringValue ?? "", "utf-8");
      const valLenBuf = Buffer.alloc(4);
      valLenBuf.writeUInt32BE(valueBytes.length);
      buffers.push(valLenBuf, valueBytes);
    } else if (attr.DataType.startsWith("Binary")) {
      buffers.push(Buffer.from([2]));
      const valueBytes = Buffer.from(attr.BinaryValue ?? "", "base64");
      const valLenBuf = Buffer.alloc(4);
      valLenBuf.writeUInt32BE(valueBytes.length);
      buffers.push(valLenBuf, valueBytes);
    }
  }

  return createHash("md5").update(Buffer.concat(buffers)).digest("hex");
}
