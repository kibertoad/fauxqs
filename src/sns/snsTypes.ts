export interface SnsTopic {
  arn: string;
  name: string;
  attributes: Record<string, string>;
  tags: Map<string, string>;
  subscriptionArns: string[];
}

export interface SnsSubscription {
  arn: string;
  topicArn: string;
  protocol: string;
  endpoint: string;
  confirmed: boolean;
  attributes: Record<string, string>;
  /** Cached parsed FilterPolicy — invalidated when attributes change. */
  parsedFilterPolicy?: Record<string, unknown>;
}

export interface SnsMessageAttribute {
  DataType: string;
  StringValue?: string;
  BinaryValue?: string;
}
