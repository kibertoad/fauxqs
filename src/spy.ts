import type { MessageAttributeValue } from "./sqs/sqsTypes.ts";

/** Possible statuses for an SQS spy message. */
export type SqsSpyMessageStatus = "published" | "consumed" | "dlq";

/** An SQS event captured by {@link MessageSpy}. */
export interface SqsSpyMessage {
  service: "sqs";
  queueName: string;
  messageId: string;
  body: string;
  messageAttributes: Record<string, MessageAttributeValue>;
  status: SqsSpyMessageStatus;
  timestamp: number;
}

/** Possible statuses for an SNS spy message. */
export type SnsSpyMessageStatus = "published";

/** An SNS event captured by {@link MessageSpy}. */
export interface SnsSpyMessage {
  service: "sns";
  topicArn: string;
  topicName: string;
  messageId: string;
  body: string;
  messageAttributes: Record<string, MessageAttributeValue>;
  status: SnsSpyMessageStatus;
  timestamp: number;
}

/** Possible statuses for an S3 spy event. */
export type S3SpyEventStatus = "uploaded" | "downloaded" | "deleted" | "copied";

/** An S3 event captured by {@link MessageSpy}. */
export interface S3SpyEvent {
  service: "s3";
  bucket: string;
  key: string;
  status: S3SpyEventStatus;
  timestamp: number;
}

/** Discriminated union of all spy event types, keyed by the `service` field. */
export type SpyMessage = SqsSpyMessage | SnsSpyMessage | S3SpyEvent;

/** @deprecated Use SqsSpyMessageStatus instead */
export type SpyMessageStatus = SqsSpyMessageStatus;

/**
 * Filter used to match spy messages. Either a predicate function or a partial
 * object whose fields are deep-compared against each message.
 */
export type MessageSpyFilter = ((msg: SpyMessage) => boolean) | Record<string, unknown>;

/** Options for configuring a {@link MessageSpy} instance. */
export interface MessageSpyParams {
  /** Maximum number of messages to keep in the buffer (FIFO eviction). Defaults to 100. */
  bufferSize?: number;
}

const DEFAULT_BUFFER_SIZE = 100;

interface PendingWaiter {
  matcher: (msg: SpyMessage) => boolean;
  resolve: (msg: SpyMessage) => void;
  reject: (err: Error) => void;
}

/** Deep-compare `matcher` fields against `target`. Returns true when every key in `matcher` equals the corresponding key in `target`. */
function objectMatches(matcher: Record<string, unknown>, target: Record<string, unknown>): boolean {
  for (const key of Object.keys(matcher)) {
    const matchVal = matcher[key];
    const targetVal = target[key];

    if (
      matchVal !== null &&
      typeof matchVal === "object" &&
      !Array.isArray(matchVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      if (
        !objectMatches(matchVal as Record<string, unknown>, targetVal as Record<string, unknown>)
      ) {
        return false;
      }
    } else if (matchVal !== targetVal) {
      return false;
    }
  }
  return true;
}

/**
 * Build a predicate from a {@link MessageSpyFilter} and an optional status string.
 * When `status` is provided, the predicate also requires `msg.status === status`.
 */
function buildMatcher(filter: MessageSpyFilter, status?: string): (msg: SpyMessage) => boolean {
  const filterFn =
    typeof filter === "function"
      ? filter
      : (msg: SpyMessage) => objectMatches(filter, msg as unknown as Record<string, unknown>);

  if (!status) return filterFn;

  return (msg: SpyMessage) => msg.status === status && filterFn(msg);
}

/**
 * Read-only view of the spy exposed via `server.spy`. Provides methods for
 * querying and awaiting tracked events but does not allow mutating spy state
 * (e.g. recording new events).
 */
export interface MessageSpyReader {
  /**
   * Wait for a message matching `filter` (and optionally `status`). Checks the
   * buffer first for retroactive resolution. If no match is found, returns a
   * Promise that resolves when a matching message arrives.
   *
   * @param filter - Predicate function or partial object to match against.
   * @param status - Optional status string to require (e.g. `"published"`, `"uploaded"`).
   */
  waitForMessage(filter: MessageSpyFilter, status?: string): Promise<SpyMessage>;

  /**
   * Shorthand for waiting by SQS/SNS `messageId`. Only matches event types that
   * have a `messageId` field (SQS and SNS, not S3).
   *
   * @param messageId - The SQS or SNS message ID to match.
   * @param status - Optional status string to require.
   */
  waitForMessageWithId(messageId: string, status?: string): Promise<SpyMessage>;

  /**
   * Synchronously check the buffer for a matching message. Returns the first
   * match or `undefined` if none is found.
   *
   * @param filter - Predicate function or partial object to match against.
   * @param status - Optional status string to require.
   */
  checkForMessage(filter: MessageSpyFilter, status?: string): SpyMessage | undefined;

  /** Return a shallow copy of all buffered messages, oldest first. */
  getAllMessages(): SpyMessage[];

  /** Empty the buffer and reject all pending waiters with an error. */
  clear(): void;
}

/**
 * Tracks events flowing through SQS, SNS, and S3. Maintains a fixed-size
 * in-memory buffer and supports both retroactive lookups and future-awaiting
 * via promises.
 *
 * Used internally by stores to record events. Consumers should use the
 * {@link MessageSpyReader} interface returned by `server.spy`.
 */
export class MessageSpy implements MessageSpyReader {
  private buffer: SpyMessage[] = [];
  private readonly bufferSize: number;
  private pendingWaiters: PendingWaiter[] = [];

  constructor(params?: MessageSpyParams) {
    this.bufferSize = params?.bufferSize ?? DEFAULT_BUFFER_SIZE;
  }

  /**
   * Record a new event. Appends to the buffer (evicting the oldest entry when
   * full) and resolves any pending waiters whose filter matches the message.
   */
  addMessage(message: SpyMessage): void {
    this.buffer.push(message);
    while (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }

    // Check pending waiters
    const stillPending: PendingWaiter[] = [];
    for (const waiter of this.pendingWaiters) {
      if (waiter.matcher(message)) {
        waiter.resolve(message);
      } else {
        stillPending.push(waiter);
      }
    }
    this.pendingWaiters = stillPending;
  }

  /**
   * Wait for a message matching `filter` (and optionally `status`). Checks the
   * buffer first for retroactive resolution. If no match is found, returns a
   * Promise that resolves when a matching message arrives via {@link addMessage}.
   *
   * @param filter - Predicate function or partial object to match against.
   * @param status - Optional status string to require (e.g. `"published"`, `"uploaded"`).
   */
  waitForMessage(filter: MessageSpyFilter, status?: string): Promise<SpyMessage> {
    const matcher = buildMatcher(filter, status);

    // Check buffer first (retroactive)
    const existing = this.buffer.find(matcher);
    if (existing) return Promise.resolve(existing);

    // Register pending waiter (future)
    return new Promise<SpyMessage>((resolve, reject) => {
      this.pendingWaiters.push({ matcher, resolve, reject });
    });
  }

  /**
   * Shorthand for waiting by SQS/SNS `messageId`. Only matches event types that
   * have a `messageId` field (SQS and SNS, not S3).
   *
   * @param messageId - The SQS or SNS message ID to match.
   * @param status - Optional status string to require.
   */
  waitForMessageWithId(messageId: string, status?: string): Promise<SpyMessage> {
    return this.waitForMessage((msg) => "messageId" in msg && msg.messageId === messageId, status);
  }

  /**
   * Synchronously check the buffer for a matching message. Returns the first
   * match or `undefined` if none is found.
   *
   * @param filter - Predicate function or partial object to match against.
   * @param status - Optional status string to require.
   */
  checkForMessage(filter: MessageSpyFilter, status?: string): SpyMessage | undefined {
    const matcher = buildMatcher(filter, status);
    return this.buffer.find(matcher);
  }

  /** Return a shallow copy of all buffered messages, oldest first. */
  getAllMessages(): SpyMessage[] {
    return [...this.buffer];
  }

  /** Empty the buffer and reject all pending waiters with an error. */
  clear(): void {
    this.buffer = [];
    const waiters = this.pendingWaiters;
    this.pendingWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(new Error("MessageSpy cleared"));
    }
  }
}
