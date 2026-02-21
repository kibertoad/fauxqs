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
