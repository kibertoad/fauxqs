import { randomUUID } from "node:crypto";
import { md5, md5OfMessageAttributes } from "../common/md5.js";
import type {
  SqsMessage,
  InflightEntry,
  ReceivedMessage,
  MessageAttributeValue,
} from "./sqsTypes.js";
import { DEFAULT_QUEUE_ATTRIBUTES, ALL_ATTRIBUTE_NAMES } from "./sqsTypes.js";

export class SqsQueue {
  readonly createdTimestamp: number;
  lastModifiedTimestamp: number;
  attributes: Record<string, string>;
  tags: Map<string, string>;
  messages: SqsMessage[] = [];
  inflightMessages: Map<string, InflightEntry> = new Map();
  delayedMessages: SqsMessage[] = [];
  pollWaiters: Array<{
    resolve: (msgs: SqsMessage[]) => void;
    maxMessages: number;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    public readonly name: string,
    public readonly url: string,
    public readonly arn: string,
    attributes?: Record<string, string>,
    tags?: Record<string, string>,
  ) {
    const now = Math.floor(Date.now() / 1000);
    this.createdTimestamp = now;
    this.lastModifiedTimestamp = now;
    this.attributes = { ...DEFAULT_QUEUE_ATTRIBUTES, ...attributes };
    this.tags = new Map(tags ? Object.entries(tags) : []);
  }

  getAllAttributes(requested: string[]): Record<string, string> {
    const names = requested.includes("All") ? ALL_ATTRIBUTE_NAMES : requested;

    const result: Record<string, string> = {};
    for (const name of names) {
      const value = this.getAttribute(name);
      if (value !== undefined) {
        result[name] = value;
      }
    }
    return result;
  }

  getAttribute(name: string): string | undefined {
    switch (name) {
      case "QueueArn":
        return this.arn;
      case "ApproximateNumberOfMessages":
        return String(this.messages.length);
      case "ApproximateNumberOfMessagesNotVisible":
        return String(this.inflightMessages.size);
      case "ApproximateNumberOfMessagesDelayed":
        return String(this.delayedMessages.length);
      case "CreatedTimestamp":
        return String(this.createdTimestamp);
      case "LastModifiedTimestamp":
        return String(this.lastModifiedTimestamp);
      default:
        return this.attributes[name];
    }
  }

  setAttributes(attrs: Record<string, string>): void {
    Object.assign(this.attributes, attrs);
    this.lastModifiedTimestamp = Math.floor(Date.now() / 1000);
  }

  enqueue(msg: SqsMessage): void {
    if (msg.delayUntil && msg.delayUntil > Date.now()) {
      this.delayedMessages.push(msg);
    } else {
      this.messages.push(msg);
      this.notifyWaiters();
    }
  }

  dequeue(
    maxCount: number,
    visibilityTimeoutOverride?: number,
    dlqResolver?: (arn: string) => SqsQueue | undefined,
  ): ReceivedMessage[] {
    this.processTimers();

    const visibilityTimeout =
      visibilityTimeoutOverride ?? parseInt(this.attributes.VisibilityTimeout);

    // Parse RedrivePolicy for DLQ
    let maxReceiveCount = Infinity;
    let dlqArn: string | undefined;
    if (this.attributes.RedrivePolicy) {
      try {
        const policy = JSON.parse(this.attributes.RedrivePolicy);
        maxReceiveCount = policy.maxReceiveCount ?? Infinity;
        dlqArn = policy.deadLetterTargetArn;
      } catch {
        // Invalid policy, ignore
      }
    }

    const count = Math.min(maxCount, this.messages.length, 10);
    const result: ReceivedMessage[] = [];
    let collected = 0;

    while (collected < count && this.messages.length > 0) {
      const msg = this.messages.shift();
      if (!msg) break;

      msg.approximateReceiveCount++;
      if (!msg.approximateFirstReceiveTimestamp) {
        msg.approximateFirstReceiveTimestamp = Date.now();
      }

      // DLQ check: if exceeded maxReceiveCount, move to DLQ
      if (dlqArn && dlqResolver && msg.approximateReceiveCount > maxReceiveCount) {
        const dlq = dlqResolver(dlqArn);
        if (dlq) {
          dlq.enqueue(msg);
          continue;
        }
      }

      const receiptHandle = randomUUID();
      const visibilityDeadline = Date.now() + visibilityTimeout * 1000;

      this.inflightMessages.set(receiptHandle, {
        message: msg,
        receiptHandle,
        visibilityDeadline,
      });

      const received: ReceivedMessage = {
        MessageId: msg.messageId,
        ReceiptHandle: receiptHandle,
        MD5OfBody: msg.md5OfBody,
        Body: msg.body,
      };

      if (msg.md5OfMessageAttributes) {
        received.MD5OfMessageAttributes = msg.md5OfMessageAttributes;
      }

      if (Object.keys(msg.messageAttributes).length > 0) {
        received.MessageAttributes = msg.messageAttributes;
      }

      result.push(received);
      collected++;
    }

    return result;
  }

  deleteMessage(receiptHandle: string): boolean {
    return this.inflightMessages.delete(receiptHandle);
  }

  changeVisibility(receiptHandle: string, timeoutSeconds: number): void {
    const entry = this.inflightMessages.get(receiptHandle);
    if (!entry) {
      return;
    }

    if (timeoutSeconds === 0) {
      this.inflightMessages.delete(receiptHandle);
      this.messages.push(entry.message);
      this.notifyWaiters();
    } else {
      entry.visibilityDeadline = Date.now() + timeoutSeconds * 1000;
    }
  }

  processTimers(): void {
    const now = Date.now();

    // Move expired inflight messages back to available
    for (const [handle, entry] of this.inflightMessages) {
      if (entry.visibilityDeadline <= now) {
        this.inflightMessages.delete(handle);
        this.messages.push(entry.message);
      }
    }

    // Move delayed messages that are now ready
    const stillDelayed: SqsMessage[] = [];
    for (const msg of this.delayedMessages) {
      if (msg.delayUntil && msg.delayUntil > now) {
        stillDelayed.push(msg);
      } else {
        this.messages.push(msg);
      }
    }
    this.delayedMessages = stillDelayed;

    if (this.messages.length > 0) {
      this.notifyWaiters();
    }
  }

  waitForMessages(maxMessages: number, waitTimeSeconds: number): Promise<SqsMessage[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pollWaiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) {
          this.pollWaiters.splice(idx, 1);
        }
        resolve([]);
      }, waitTimeSeconds * 1000);

      this.pollWaiters.push({ resolve, maxMessages, timer });
    });
  }

  purge(): void {
    this.messages = [];
    this.delayedMessages = [];
    // Inflight messages are NOT purged (matches AWS behavior)
  }

  private notifyWaiters(): void {
    while (this.pollWaiters.length > 0 && this.messages.length > 0) {
      const waiter = this.pollWaiters.shift()!;
      clearTimeout(waiter.timer);
      const count = Math.min(waiter.maxMessages, this.messages.length);
      const msgs = this.messages.splice(0, count);
      waiter.resolve(msgs);
    }
  }
}

export class SqsStore {
  private queues = new Map<string, SqsQueue>();
  private queuesByName = new Map<string, SqsQueue>();
  host?: string;

  createQueue(
    name: string,
    url: string,
    arn: string,
    attributes?: Record<string, string>,
    tags?: Record<string, string>,
  ): SqsQueue {
    const queue = new SqsQueue(name, url, arn, attributes, tags);
    this.queues.set(url, queue);
    this.queuesByName.set(name, queue);
    return queue;
  }

  deleteQueue(url: string): boolean {
    const queue = this.queues.get(url);
    if (!queue) return false;
    this.queues.delete(url);
    this.queuesByName.delete(queue.name);
    return true;
  }

  getQueue(url: string): SqsQueue | undefined {
    return this.queues.get(url);
  }

  getQueueByName(name: string): SqsQueue | undefined {
    return this.queuesByName.get(name);
  }

  listQueues(prefix?: string, maxResults?: number): SqsQueue[] {
    let queues = Array.from(this.queues.values());
    if (prefix) {
      queues = queues.filter((q) => q.name.startsWith(prefix));
    }
    if (maxResults) {
      queues = queues.slice(0, maxResults);
    }
    return queues;
  }

  getQueueByArn(arn: string): SqsQueue | undefined {
    for (const queue of this.queues.values()) {
      if (queue.arn === arn) return queue;
    }
    return undefined;
  }

  processAllTimers(): void {
    for (const queue of this.queues.values()) {
      queue.processTimers();
    }
  }

  static createMessage(
    body: string,
    messageAttributes: Record<string, MessageAttributeValue> = {},
    delaySeconds?: number,
  ): SqsMessage {
    const now = Date.now();
    return {
      messageId: randomUUID(),
      body,
      md5OfBody: md5(body),
      messageAttributes,
      md5OfMessageAttributes: md5OfMessageAttributes(messageAttributes),
      sentTimestamp: now,
      approximateReceiveCount: 0,
      delayUntil: delaySeconds ? now + delaySeconds * 1000 : undefined,
    };
  }
}
