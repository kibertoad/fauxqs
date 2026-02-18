import { escapeXml } from "./xml.js";

export class SqsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly senderFault: boolean = true,
  ) {
    super(message);
    this.name = "SqsError";
  }

  toJSON() {
    return {
      __type: `com.amazonaws.sqs#${this.code}`,
      message: this.message,
    };
  }

  get queryErrorHeader(): string {
    const fault = this.senderFault ? "Sender" : "Receiver";
    return `AWS.SimpleQueueService.${this.code};${fault}`;
  }
}

export class SnsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly senderFault: boolean = true,
  ) {
    super(message);
    this.name = "SnsError";
  }
}

export class S3Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly resource?: string,
  ) {
    super(message);
    this.name = "S3Error";
  }

  toXml(): string {
    const parts = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<Error>`,
      `  <Code>${this.code}</Code>`,
      `  <Message>${escapeXml(this.message)}</Message>`,
    ];
    if (this.resource) {
      parts.push(`  <Resource>${escapeXml(this.resource)}</Resource>`);
    }
    parts.push(`</Error>`);
    return parts.join("\n");
  }
}
