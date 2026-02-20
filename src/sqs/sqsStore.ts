import { randomUUID, createHash } from "node:crypto";
import type { QueueAttributeName } from "@aws-sdk/client-sqs";
import { FifoMap } from "toad-cache";
import { md5, md5OfMessageAttributes } from "../common/md5.ts";
import { DEFAULT_ACCOUNT_ID } from "../common/types.ts";
import type { MessageSpy } from "../spy.ts";
import type {
  SqsMessage,
  InflightEntry,
  ReceivedMessage,
  MessageAttributeValue,
} from "./sqsTypes.ts";
import { DEFAULT_QUEUE_ATTRIBUTES, ALL_ATTRIBUTE_NAMES } from "./sqsTypes.ts";

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEDUP_CACHE_MAX_SIZE = 10_000;

export class SqsQueue {
  readonly name: string;
  readonly url: string;
  readonly arn: string;
  readonly createdTimestamp: number;
  lastModifiedTimestamp: number;
  attributes: Record<string, string>;
  tags: Map<string, string>;
  messages: SqsMessage[] = [];
  inflightMessages: Map<string, InflightEntry> = new Map();
  delayedMessages: SqsMessage[] = [];
  pollWaiters: Array<{
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private pollTimer?: ReturnType<typeof setInterval>;

  spy?: MessageSpy;

  // FIFO-specific fields
  fifoMessages: Map<string, SqsMessage[]> = new Map();
  fifoDelayed: Map<string, SqsMessage[]> = new Map();
  fifoLockedGroups: Map<string, number> = new Map();
  deduplicationCache = new FifoMap<{ messageId: string; sequenceNumber?: string }>(
    DEDUP_CACHE_MAX_SIZE,
    DEDUP_WINDOW_MS,
  );
  sequenceCounter = 0;

  constructor(
    name: string,
    url: string,
    arn: string,
    attributes?: Record<string, string>,
    tags?: Record<string, string>,
  ) {
    this.name = name;
    this.url = url;
    this.arn = arn;
    const now = Math.floor(Date.now() / 1000);
    this.createdTimestamp = now;
    this.lastModifiedTimestamp = now;
    this.attributes = { ...DEFAULT_QUEUE_ATTRIBUTES, ...attributes };
    this.tags = new Map(tags ? Object.entries(tags) : []);
  }

  isFifo(): boolean {
    return this.attributes.FifoQueue === "true";
  }

  getAllAttributes(requested: string[]): Record<string, string> {
    const names = requested.includes("All")
      ? ALL_ATTRIBUTE_NAMES
      : (requested as QueueAttributeName[]);

    const result: Record<string, string> = {};
    for (const name of names) {
      const value = this.getAttribute(name);
      if (value !== undefined) {
        result[name] = value;
      }
    }
    return result;
  }

  getAttribute(name: QueueAttributeName): string | undefined {
    switch (name) {
      case "QueueArn":
        return this.arn;
      case "ApproximateNumberOfMessages":
        if (this.isFifo()) {
          let total = 0;
          for (const msgs of this.fifoMessages.values()) {
            total += msgs.length;
          }
          return String(total);
        }
        return String(this.messages.length);
      case "ApproximateNumberOfMessagesNotVisible":
        return String(this.inflightMessages.size);
      case "ApproximateNumberOfMessagesDelayed":
        if (this.isFifo()) {
          let total = 0;
          for (const msgs of this.fifoDelayed.values()) {
            total += msgs.length;
          }
          return String(total);
        }
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
    if (this.spy) {
      this.spy.addMessage({
        service: "sqs",
        queueName: this.name,
        messageId: msg.messageId,
        body: msg.body,
        messageAttributes: msg.messageAttributes,
        status: "published",
        timestamp: Date.now(),
      });
    }

    if (this.isFifo()) {
      const groupId = msg.messageGroupId ?? "__default";
      if (msg.delayUntil && msg.delayUntil > Date.now()) {
        const group = this.fifoDelayed.get(groupId) ?? [];
        group.push(msg);
        this.fifoDelayed.set(groupId, group);
      } else {
        const group = this.fifoMessages.get(groupId) ?? [];
        group.push(msg);
        this.fifoMessages.set(groupId, group);
        this.notifyWaiters();
      }
      return;
    }

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
    if (this.isFifo()) {
      return this.dequeueFifo(maxCount, visibilityTimeoutOverride, dlqResolver);
    }

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
          if (this.spy) {
            this.spy.addMessage({
              service: "sqs",
              queueName: this.name,
              messageId: msg.messageId,
              body: msg.body,
              messageAttributes: msg.messageAttributes,
              status: "dlq",
              timestamp: Date.now(),
            });
          }
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

  private dequeueFifo(
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

    const result: ReceivedMessage[] = [];
    const count = Math.min(maxCount, 10);

    for (const [groupId, groupMsgs] of this.fifoMessages) {
      if (result.length >= count) break;
      if (this.fifoLockedGroups.has(groupId)) continue;
      if (groupMsgs.length === 0) continue;

      // Take messages from this group in order (up to remaining count)
      while (result.length < count && groupMsgs.length > 0) {
        const msg = groupMsgs.shift()!;

        msg.approximateReceiveCount++;
        if (!msg.approximateFirstReceiveTimestamp) {
          msg.approximateFirstReceiveTimestamp = Date.now();
        }

        // DLQ check
        if (dlqArn && dlqResolver && msg.approximateReceiveCount > maxReceiveCount) {
          const dlq = dlqResolver(dlqArn);
          if (dlq) {
            if (this.spy) {
              this.spy.addMessage({
                service: "sqs",
                queueName: this.name,
                messageId: msg.messageId,
                body: msg.body,
                messageAttributes: msg.messageAttributes,
                status: "dlq",
                timestamp: Date.now(),
              });
            }
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

        // Once a message from this group is inflight, the group is locked
        this.fifoLockedGroups.set(groupId, (this.fifoLockedGroups.get(groupId) ?? 0) + 1);
        break;
      }

      // Clean up empty groups
      if (groupMsgs.length === 0) {
        this.fifoMessages.delete(groupId);
      }
    }

    return result;
  }

  deleteMessage(receiptHandle: string): boolean {
    const entry = this.inflightMessages.get(receiptHandle);
    if (entry) {
      if (this.spy) {
        this.spy.addMessage({
          service: "sqs",
          queueName: this.name,
          messageId: entry.message.messageId,
          body: entry.message.body,
          messageAttributes: entry.message.messageAttributes,
          status: "consumed",
          timestamp: Date.now(),
        });
      }
      // Decrement FIFO locked group count
      if (entry.message.messageGroupId) {
        const groupId = entry.message.messageGroupId;
        const count = (this.fifoLockedGroups.get(groupId) ?? 1) - 1;
        if (count <= 0) {
          this.fifoLockedGroups.delete(groupId);
          // Notify waiters: the group is now unlocked, so queued messages become available
          if (this.fifoMessages.has(groupId)) {
            this.notifyWaiters();
          }
        } else {
          this.fifoLockedGroups.set(groupId, count);
        }
      }
    }
    return this.inflightMessages.delete(receiptHandle);
  }

  changeVisibility(receiptHandle: string, timeoutSeconds: number): void {
    const entry = this.inflightMessages.get(receiptHandle);
    if (!entry) {
      return;
    }

    if (timeoutSeconds === 0) {
      this.inflightMessages.delete(receiptHandle);
      if (this.isFifo() && entry.message.messageGroupId) {
        const groupId = entry.message.messageGroupId;
        // Decrement locked group count
        const lockCount = (this.fifoLockedGroups.get(groupId) ?? 1) - 1;
        if (lockCount <= 0) {
          this.fifoLockedGroups.delete(groupId);
        } else {
          this.fifoLockedGroups.set(groupId, lockCount);
        }
        const group = this.fifoMessages.get(groupId) ?? [];
        group.unshift(entry.message);
        this.fifoMessages.set(groupId, group);
      } else {
        this.messages.push(entry.message);
      }
      this.notifyWaiters();
    } else {
      entry.visibilityDeadline = Date.now() + timeoutSeconds * 1000;
    }
  }

  processTimers(): void {
    const now = Date.now();

    if (this.isFifo()) {
      // Move expired inflight messages back to front of their group
      for (const [handle, entry] of this.inflightMessages) {
        if (entry.visibilityDeadline <= now) {
          this.inflightMessages.delete(handle);
          const groupId = entry.message.messageGroupId ?? "__default";
          // Decrement locked group count
          const lockCount = (this.fifoLockedGroups.get(groupId) ?? 1) - 1;
          if (lockCount <= 0) {
            this.fifoLockedGroups.delete(groupId);
          } else {
            this.fifoLockedGroups.set(groupId, lockCount);
          }
          const group = this.fifoMessages.get(groupId) ?? [];
          group.unshift(entry.message);
          this.fifoMessages.set(groupId, group);
        }
      }

      // Move delayed FIFO messages that are now ready
      for (const [groupId, delayedMsgs] of this.fifoDelayed) {
        const stillDelayed: SqsMessage[] = [];
        for (const msg of delayedMsgs) {
          if (msg.delayUntil && msg.delayUntil > now) {
            stillDelayed.push(msg);
          } else {
            const group = this.fifoMessages.get(groupId) ?? [];
            group.push(msg);
            this.fifoMessages.set(groupId, group);
          }
        }
        if (stillDelayed.length === 0) {
          this.fifoDelayed.delete(groupId);
        } else {
          this.fifoDelayed.set(groupId, stillDelayed);
        }
      }

      if (this.hasAvailableFifoMessages()) {
        this.notifyWaiters();
      }
      return;
    }

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

  waitForMessages(waitTimeSeconds: number): Promise<void> {
    return new Promise((resolve) => {
      const wrappedResolve = () => {
        resolve();
        this.stopPollTimerIfEmpty();
      };

      const timer = setTimeout(() => {
        const idx = this.pollWaiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) {
          this.pollWaiters.splice(idx, 1);
        }
        wrappedResolve();
      }, waitTimeSeconds * 1000);

      this.pollWaiters.push({ resolve: wrappedResolve, timer });
      this.startPollTimerIfNeeded();
    });
  }

  private startPollTimerIfNeeded(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.processTimers();
    }, 20);
  }

  private stopPollTimerIfEmpty(): void {
    if (this.pollWaiters.length === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  purge(): void {
    this.messages = [];
    this.delayedMessages = [];
    this.inflightMessages.clear();
    this.fifoMessages.clear();
    this.fifoDelayed.clear();
    this.fifoLockedGroups.clear();
  }

  /** Return a non-destructive snapshot of all messages in the queue, grouped by state. */
  inspectMessages(): {
    ready: SqsMessage[];
    delayed: SqsMessage[];
    inflight: Array<{ message: SqsMessage; receiptHandle: string; visibilityDeadline: number }>;
  } {
    let ready: SqsMessage[];
    let delayed: SqsMessage[];

    if (this.isFifo()) {
      ready = [];
      for (const msgs of this.fifoMessages.values()) {
        ready.push(...msgs);
      }
      delayed = [];
      for (const msgs of this.fifoDelayed.values()) {
        delayed.push(...msgs);
      }
    } else {
      ready = [...this.messages];
      delayed = [...this.delayedMessages];
    }

    const inflight = Array.from(this.inflightMessages.values()).map((entry) => ({
      message: entry.message,
      receiptHandle: entry.receiptHandle,
      visibilityDeadline: entry.visibilityDeadline,
    }));

    return { ready, delayed, inflight };
  }

  cancelWaiters(): void {
    for (const waiter of this.pollWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.pollWaiters = [];
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  checkDeduplication(dedupId: string): {
    isDuplicate: boolean;
    originalMessageId?: string;
    originalSequenceNumber?: string;
  } {
    const existing = this.deduplicationCache.get(dedupId);
    if (existing) {
      return {
        isDuplicate: true,
        originalMessageId: existing.messageId,
        originalSequenceNumber: existing.sequenceNumber,
      };
    }

    return { isDuplicate: false };
  }

  recordDeduplication(dedupId: string, messageId: string, sequenceNumber?: string): void {
    this.deduplicationCache.set(dedupId, { messageId, sequenceNumber });
  }

  nextSequenceNumber(): string {
    this.sequenceCounter++;
    return String(this.sequenceCounter).padStart(20, "0");
  }

  private hasAvailableFifoMessages(): boolean {
    for (const [groupId, msgs] of this.fifoMessages) {
      if (msgs.length > 0 && !this.fifoLockedGroups.has(groupId)) return true;
    }
    return false;
  }

  private notifyWaiters(): void {
    // Signal waiters that messages are available; they will call dequeue() themselves
    while (this.pollWaiters.length > 0) {
      const waiter = this.pollWaiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }
}

export class SqsStore {
  private queues = new Map<string, SqsQueue>();
  private queuesByName = new Map<string, SqsQueue>();
  private queuesByArn = new Map<string, SqsQueue>();
  host: string = "localhost";
  region?: string;
  spy?: MessageSpy;

  createQueue(
    name: string,
    url: string,
    arn: string,
    attributes?: Record<string, string>,
    tags?: Record<string, string>,
  ): SqsQueue {
    const queue = new SqsQueue(name, url, arn, attributes, tags);
    if (this.spy) {
      queue.spy = this.spy;
    }
    this.queues.set(url, queue);
    this.queuesByName.set(name, queue);
    this.queuesByArn.set(arn, queue);
    return queue;
  }

  deleteQueue(url: string): boolean {
    const queue = this.queues.get(url);
    if (!queue) return false;
    queue.cancelWaiters();
    this.queues.delete(url);
    this.queuesByName.delete(queue.name);
    this.queuesByArn.delete(queue.arn);
    return true;
  }

  buildQueueUrl(queueName: string, port: string, requestHost: string, region: string): string {
    const host = this.host ? `sqs.${region}.${this.host}${port ? `:${port}` : ""}` : requestHost;
    return `http://${host}/${DEFAULT_ACCOUNT_ID}/${queueName}`;
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
    return this.queuesByArn.get(arn);
  }

  inspectQueue(name: string):
    | {
        name: string;
        url: string;
        arn: string;
        attributes: Record<string, string>;
        messages: {
          ready: SqsMessage[];
          delayed: SqsMessage[];
          inflight: Array<{
            message: SqsMessage;
            receiptHandle: string;
            visibilityDeadline: number;
          }>;
        };
      }
    | undefined {
    const queue = this.queuesByName.get(name);
    if (!queue) return undefined;
    return {
      name: queue.name,
      url: queue.url,
      arn: queue.arn,
      attributes: queue.getAllAttributes(["All"]),
      messages: queue.inspectMessages(),
    };
  }

  processAllTimers(): void {
    for (const queue of this.queues.values()) {
      queue.processTimers();
    }
  }

  shutdown(): void {
    for (const queue of this.queues.values()) {
      queue.cancelWaiters();
    }
  }

  purgeAll(): void {
    this.shutdown();
    this.queues.clear();
    this.queuesByName.clear();
    this.queuesByArn.clear();
  }

  static createMessage(
    body: string,
    messageAttributes: Record<string, MessageAttributeValue> = {},
    delaySeconds?: number,
    messageGroupId?: string,
    messageDeduplicationId?: string,
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
      messageGroupId,
      messageDeduplicationId,
    };
  }

  static contentBasedDeduplicationId(body: string): string {
    return createHash("sha256").update(body).digest("hex");
  }
}
