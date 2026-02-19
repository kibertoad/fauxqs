import { escapeXml } from "./xml.ts";

export class SqsError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly senderFault: boolean;

  constructor(code: string, message: string, statusCode: number = 400, senderFault: boolean = true) {
    super(message);
    this.name = "SqsError";
    this.code = code;
    this.statusCode = statusCode;
    this.senderFault = senderFault;
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
  readonly code: string;
  readonly statusCode: number;
  readonly senderFault: boolean;

  constructor(code: string, message: string, statusCode: number = 400, senderFault: boolean = true) {
    super(message);
    this.name = "SnsError";
    this.code = code;
    this.statusCode = statusCode;
    this.senderFault = senderFault;
  }
}

export class S3Error extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly resource?: string;

  constructor(code: string, message: string, statusCode: number = 400, resource?: string) {
    super(message);
    this.name = "S3Error";
    this.code = code;
    this.statusCode = statusCode;
    this.resource = resource;
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
