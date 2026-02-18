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
