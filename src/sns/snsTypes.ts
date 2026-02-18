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
}

export interface SnsMessageAttribute {
  DataType: string;
  StringValue?: string;
  BinaryValue?: string;
}
