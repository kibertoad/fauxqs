import { randomUUID } from "node:crypto";

const SNS_XMLNS = "http://sns.amazonaws.com/doc/2010-03-31/";

export function snsSuccessResponse(action: string, resultBody: string): string {
  return [
    `<${action}Response xmlns="${SNS_XMLNS}">`,
    `  <${action}Result>`,
    `    ${resultBody}`,
    `  </${action}Result>`,
    `  <ResponseMetadata>`,
    `    <RequestId>${randomUUID()}</RequestId>`,
    `  </ResponseMetadata>`,
    `</${action}Response>`,
  ].join("\n");
}

export function snsErrorResponse(
  code: string,
  message: string,
  type: "Sender" | "Receiver" = "Sender",
): string {
  return [
    `<ErrorResponse xmlns="${SNS_XMLNS}">`,
    `  <Error>`,
    `    <Type>${type}</Type>`,
    `    <Code>${code}</Code>`,
    `    <Message>${escapeXml(message)}</Message>`,
    `  </Error>`,
    `  <RequestId>${randomUUID()}</RequestId>`,
    `</ErrorResponse>`,
  ].join("\n");
}

export function escapeXml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Reverse of {@link escapeXml}. The `&amp;` entity is decoded last so that an
 * escaped entity reference (e.g. `&amp;lt;`) round-trips to `&lt;` rather than
 * being double-decoded into `<`.
 */
export function unescapeXml(str: string): string {
  return str
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * Read the text of the first `<name>` element in `source`, unescaped, or
 * `undefined` when the element is absent. Deliberately regex-based rather than a
 * parser: the S3 request bodies fauxqs reads are flat and machine-generated.
 */
export function xmlElement(source: string, name: string): string | undefined {
  const match = new RegExp(String.raw`<${name}>([\s\S]*?)</${name}>`).exec(source);
  return match ? unescapeXml(match[1]) : undefined;
}

/**
 * Whether every `<name>` opening tag in `source` is closed. {@link xmlBlocks}
 * skips an unclosed element rather than failing, so a truncated document reads
 * as a shorter valid one — `<Delete><Object><Key>k</Key></Object>` with no
 * `</Delete>` looks like a complete one-key request. A caller that must reject a
 * malformed body checks the elements it relies on with this first.
 */
export function xmlTagsClosed(source: string, name: string): boolean {
  return countOccurrences(source, `<${name}>`) === countOccurrences(source, `</${name}>`);
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/**
 * The inner text of every `<name>` element in `source`, in document order. Left
 * escaped, unlike {@link xmlElement}, so nested elements can be read out of each
 * block; unescape yourself when the elements hold text.
 */
export function xmlBlocks(source: string, name: string): string[] {
  const pattern = new RegExp(String.raw`<${name}>([\s\S]*?)</${name}>`, "g");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}
