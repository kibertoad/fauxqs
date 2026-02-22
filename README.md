<img src="logo-readme.jpg" alt="fauxqs" width="360" />

# fauxqs

Local SNS/SQS/S3 emulator for development and testing. Point your `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`, and `@aws-sdk/client-s3` clients at fauxqs instead of real AWS.

All state is in-memory. No persistence, no external storage dependencies.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
  - [Running the server](#running-the-server)
  - [Running in the background](#running-in-the-background)
  - [Running with Docker](#running-with-docker)
  - [Running in Docker Compose](#running-in-docker-compose)
    - [Container-to-container S3 virtual-hosted-style](#container-to-container-s3-virtual-hosted-style)
  - [Configuring AWS SDK clients](#configuring-aws-sdk-clients)
  - [Programmatic usage](#programmatic-usage)
    - [Programmatic state setup](#programmatic-state-setup)
    - [Sending messages programmatically](#sending-messages-programmatically)
    - [Init config file](#init-config-file)
    - [Init config schema reference](#init-config-schema-reference)
    - [Message spy](#message-spy)
    - [Queue inspection](#queue-inspection)
  - [Configurable queue URL host](#configurable-queue-url-host)
  - [Region](#region)
- [Supported API Actions](#supported-api-actions)
  - [SQS](#sqs)
  - [SNS](#sns)
  - [S3](#s3)
  - [STS](#sts)
- [SQS Features](#sqs-features)
- [SNS Features](#sns-features)
- [S3 Features](#s3-features)
  - [S3 URL styles](#s3-url-styles)
  - [Using with AWS CLI](#using-with-aws-cli)
- [Testing Strategies](#testing-strategies)
  - [Library mode for tests](#library-mode-for-tests)
  - [Docker mode for local development](#docker-mode-for-local-development)
  - [Recommended combination](#recommended-combination)
- [Conventions](#conventions)
- [Limitations](#limitations)
- [Examples](#examples)
- [Migrating from LocalStack](#migrating-from-localstack)
  - [SNS/SQS only](#snssqs-only)
  - [SNS/SQS/S3](#snssqss3)
  - [Going hybrid (recommended)](#going-hybrid-recommended)
- [Benchmarks](#benchmarks)
- [License](#license)

## Installation

**Docker** (recommended for standalone usage) — [Docker Hub](https://hub.docker.com/r/kibertoad/fauxqs):

```bash
docker run -p 4566:4566 kibertoad/fauxqs
```

**npm** (for embedded library usage or CLI):

```bash
npm install fauxqs
```

## Usage

### Running the server

```bash
npx fauxqs
```

The server starts on port `4566` and handles SQS, SNS, and S3 on a single endpoint.

#### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FAUXQS_PORT` | Port to listen on | `4566` |
| `FAUXQS_HOST` | Host for queue URLs (`sqs.<region>.<host>` format) | `localhost` |
| `FAUXQS_DEFAULT_REGION` | Fallback region for ARNs and URLs | `us-east-1` |
| `FAUXQS_LOGGER` | Enable request logging (`true`/`false`) | `true` |
| `FAUXQS_INIT` | Path to a JSON init config file (see [Init config file](#init-config-file)) | (none) |
| `FAUXQS_DNS_NAME` | Domain that dnsmasq resolves (including all subdomains) to the container IP. Only needed when the container hostname doesn't match the docker-compose service name — e.g., when using `container_name` or running with plain `docker run`. In docker-compose the hostname is set to the service name automatically, so this is rarely needed. (Docker only) | container hostname |
| `FAUXQS_DNS_UPSTREAM` | Where dnsmasq forwards non-fauxqs DNS queries (e.g., `registry.npmjs.org`). Change this if you're in a corporate network with an internal DNS server, or if you prefer a different public resolver like `1.1.1.1`. (Docker only) | `8.8.8.8` |

```bash
FAUXQS_PORT=3000 FAUXQS_INIT=init.json npx fauxqs
```

A health check is available at `GET /health`.

### Running in the background

To keep fauxqs running while you work on your app or run tests repeatedly, start it as a background process:

```bash
npx fauxqs &
```

Or in a separate terminal:

```bash
npx fauxqs
```

All state accumulates in memory across requests, so queues, topics, and objects persist until the server is stopped.

To stop the server:

```bash
# If backgrounded in the same shell
kill %1

# Cross-platform, by port
npx cross-port-killer 4566
```

### Running with Docker

The official Docker image is available on Docker Hub:

```bash
docker run -p 4566:4566 kibertoad/fauxqs
```

With an init config file:

```bash
docker run -p 4566:4566 \
  -v ./init.json:/app/init.json \
  -e FAUXQS_INIT=/app/init.json \
  kibertoad/fauxqs
```

### Running in Docker Compose

Use the `kibertoad/fauxqs` image and mount a JSON init config to pre-create resources on startup:

```json
// scripts/fauxqs/init.json
{
  "queues": [
    {
      "name": "my-queue.fifo",
      "attributes": { "FifoQueue": "true", "ContentBasedDeduplication": "true" }
    },
    { "name": "my-dlq" }
  ],
  "topics": [{ "name": "my-events" }],
  "subscriptions": [{ "topic": "my-events", "queue": "my-dlq" }],
  "buckets": ["my-uploads"]
}
```

```yaml
# docker-compose.yml
services:
  fauxqs:
    image: kibertoad/fauxqs:latest
    ports:
      - "4566:4566"
    environment:
      - FAUXQS_INIT=/app/init.json
    volumes:
      - ./scripts/fauxqs/init.json:/app/init.json

  app:
    # ...
    depends_on:
      fauxqs:
        condition: service_healthy
```

The image has a built-in `HEALTHCHECK`, so `service_healthy` works without extra configuration in your compose file. Other containers reference fauxqs using the Docker service name (`http://fauxqs:4566`). The init config file creates all queues, topics, subscriptions, and buckets before the healthcheck passes, so dependent services start only after resources are ready.

#### Container-to-container S3 virtual-hosted-style

The Docker image includes a built-in DNS server ([dnsmasq](https://thekelleys.org.uk/dnsmasq/doc.html)) that resolves the container hostname and all its subdomains (e.g., `fauxqs`, `s3.fauxqs`, `my-bucket.s3.fauxqs`) to the container's own IP. This enables virtual-hosted-style S3 from other containers without `forcePathStyle`.

To use it, assign fauxqs a static IP and point other containers' DNS to it:

```yaml
# docker-compose.yml
services:
  fauxqs:
    image: kibertoad/fauxqs:latest
    networks:
      default:
        ipv4_address: 10.0.0.2
    ports:
      - "4566:4566"
    environment:
      - FAUXQS_INIT=/app/init.json
      - FAUXQS_HOST=fauxqs
    volumes:
      - ./scripts/fauxqs/init.json:/app/init.json

  app:
    dns: 10.0.0.2
    depends_on:
      fauxqs:
        condition: service_healthy
    environment:
      - AWS_ENDPOINT=http://s3.fauxqs:4566

networks:
  default:
    ipam:
      config:
        - subnet: 10.0.0.0/24
```

From the `app` container, `my-bucket.s3.fauxqs` resolves to `10.0.0.2` (the fauxqs container), so virtual-hosted-style S3 works:

```typescript
const s3 = new S3Client({
  endpoint: "http://s3.fauxqs:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  // No forcePathStyle needed!
});
```

The DNS server is configured automatically using the container hostname (which docker-compose sets to the service name), so in most setups no extra configuration is needed. See the [environment variables table](#environment-variables) for `FAUXQS_DNS_NAME` and `FAUXQS_DNS_UPSTREAM` if you need to override the defaults.

### Configuring AWS SDK clients

Point your SDK clients at the local server:

```typescript
import { SQSClient } from "@aws-sdk/client-sqs";
import { SNSClient } from "@aws-sdk/client-sns";
import { S3Client } from "@aws-sdk/client-s3";

const sqsClient = new SQSClient({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const snsClient = new SNSClient({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

// Using fauxqs.dev wildcard DNS — no helpers or forcePathStyle needed
const s3Client = new S3Client({
  endpoint: "http://s3.localhost.fauxqs.dev:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
```

Any credentials are accepted and never validated.

> **Note:** The `fauxqs.dev` wildcard DNS (`*.localhost.fauxqs.dev` → `127.0.0.1`) replicates the approach [pioneered by LocalStack](https://hashnode.localstack.cloud/efficient-localstack-s3-endpoint-configuration) with `localhost.localstack.cloud`. A public DNS entry resolves all subdomains to localhost, so virtual-hosted-style S3 requests work without `/etc/hosts` changes, custom request handlers, or `forcePathStyle`. See [S3 URL styles](#s3-url-styles) for alternative approaches.

### Programmatic usage

You can also embed fauxqs directly in your test suite:

```typescript
import { startFauxqs } from "fauxqs";

const server = await startFauxqs({ port: 4566, logger: false });

console.log(server.address); // "http://127.0.0.1:4566"
console.log(server.port);    // 4566

// point your SDK clients at server.address

// clean up when done
await server.stop();
```

Pass `port: 0` to let the OS assign a random available port (useful in tests).

#### Programmatic state setup

The server object exposes methods for pre-creating resources without going through the SDK:

```typescript
const server = await startFauxqs({ port: 0, logger: false });

// Create individual resources — each returns metadata about the created resource
const { queueUrl, queueArn, queueName } = server.createQueue("my-queue");
const { queueUrl: dlqUrl } = server.createQueue("my-dlq", {
  attributes: { VisibilityTimeout: "60" },
  tags: { env: "test" },
});
const { topicArn } = server.createTopic("my-topic");
server.subscribe({ topic: "my-topic", queue: "my-queue" });
const { bucketName } = server.createBucket("my-bucket");

// Create resources in a specific region
server.createQueue("eu-queue", { region: "eu-west-1" });
server.createTopic("eu-topic", { region: "eu-west-1" });
server.subscribe({ topic: "eu-topic", queue: "eu-queue", region: "eu-west-1" });

// Or create everything at once
server.setup({
  queues: [
    { name: "orders" },
    { name: "notifications", attributes: { DelaySeconds: "5" } },
    { name: "eu-orders", region: "eu-west-1" },
  ],
  topics: [{ name: "events" }],
  subscriptions: [
    { topic: "events", queue: "orders" },
    { topic: "events", queue: "notifications" },
  ],
  buckets: ["uploads", "exports"],
});

// Delete individual resources (uses defaultRegion; pass { region } to override)
server.deleteQueue("my-queue");                          // no-op if queue doesn't exist
server.deleteQueue("eu-queue", { region: "eu-west-1" }); // delete in specific region
server.deleteTopic("my-topic");                          // also removes associated subscriptions
server.deleteTopic("eu-topic", { region: "eu-west-1" });
server.emptyBucket("my-bucket");                         // removes all objects, keeps the bucket

// Clear all messages and S3 objects between tests (keeps queues, topics, subscriptions, buckets)
server.reset();

// Or nuke everything — removes queues, topics, subscriptions, and buckets too
server.purgeAll();
```

#### Sending messages programmatically

Send SQS messages and publish to SNS topics without instantiating SDK clients:

```typescript
// SQS: enqueue a message directly
const { messageId, md5OfBody } = server.sendMessage("my-queue", "hello world");

// With message attributes
server.sendMessage("my-queue", JSON.stringify({ orderId: "123" }), {
  messageAttributes: {
    eventType: { DataType: "String", StringValue: "order.created" },
  },
});

// With delay
server.sendMessage("my-queue", "delayed message", { delaySeconds: 10 });

// FIFO queue — returns sequenceNumber
const { sequenceNumber } = server.sendMessage("my-queue.fifo", "fifo message", {
  messageGroupId: "group-1",
  messageDeduplicationId: "dedup-1",
});

// SNS: publish to a topic (fans out to all SQS subscriptions)
const { messageId: snsMessageId } = server.publish("my-topic", "event payload");

// With subject and message attributes
server.publish("my-topic", JSON.stringify({ orderId: "456" }), {
  subject: "Order Update",
  messageAttributes: {
    eventType: { DataType: "String", StringValue: "order.updated" },
  },
});

// FIFO topic
server.publish("my-topic.fifo", "fifo event", {
  messageGroupId: "group-1",
  messageDeduplicationId: "dedup-1",
});
```

`sendMessage` validates the message body (invalid characters, size limits), applies queue-level `DelaySeconds` defaults, handles FIFO deduplication, and emits spy events automatically. Returns `{ messageId, md5OfBody, md5OfMessageAttributes?, sequenceNumber? }`.

`publish` validates message size, evaluates filter policies on each subscription, supports raw message delivery, and emits spy events. Returns `{ messageId }`.

Both methods throw if the target queue or topic doesn't exist.

#### Init config file

Create a JSON file to pre-create resources on startup. The file is validated on load — malformed configs produce a clear error instead of silent failures.

```json
{
  "queues": [
    { "name": "orders" },
    { "name": "orders-dlq" },
    { "name": "orders.fifo", "attributes": { "FifoQueue": "true", "ContentBasedDeduplication": "true" } }
  ],
  "topics": [
    { "name": "events" }
  ],
  "subscriptions": [
    { "topic": "events", "queue": "orders" }
  ],
  "buckets": ["uploads", "exports"]
}
```

Pass it via the `FAUXQS_INIT` environment variable or the `init` option:

```bash
FAUXQS_INIT=init.json npx fauxqs
```

```typescript
const server = await startFauxqs({ init: "init.json" });
// or inline:
const server = await startFauxqs({
  init: { queues: [{ name: "my-queue" }], buckets: ["my-bucket"] },
});
```

#### Init config schema reference

All top-level fields are optional. Resources are created in dependency order: queues, topics, subscriptions, buckets.

##### `queues`

Array of queue objects.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Queue name. Use `.fifo` suffix for FIFO queues. |
| `region` | `string` | No | Override the default region for this queue. The queue's ARN and URL will use this region. |
| `attributes` | `Record<string, string>` | No | Queue attributes (see table below). |
| `tags` | `Record<string, string>` | No | Key-value tags for the queue. |

Supported queue attributes:

| Attribute | Default | Range / Values |
|-----------|---------|----------------|
| `VisibilityTimeout` | `"30"` | `0` – `43200` (seconds) |
| `DelaySeconds` | `"0"` | `0` – `900` (seconds) |
| `MaximumMessageSize` | `"1048576"` | `1024` – `1048576` (bytes) |
| `MessageRetentionPeriod` | `"345600"` | `60` – `1209600` (seconds) |
| `ReceiveMessageWaitTimeSeconds` | `"0"` | `0` – `20` (seconds) |
| `RedrivePolicy` | — | JSON string: `{"deadLetterTargetArn": "arn:...", "maxReceiveCount": "5"}` |
| `Policy` | — | Queue policy JSON string (stored, not enforced) |
| `KmsMasterKeyId` | — | KMS key ID (stored, no actual encryption) |
| `KmsDataKeyReusePeriodSeconds` | — | KMS data key reuse period (stored, no actual encryption) |
| `FifoQueue` | — | `"true"` for FIFO queues (queue name must end with `.fifo`) |
| `ContentBasedDeduplication` | — | `"true"` or `"false"` (FIFO queues only) |

Example:

```json
{
  "queues": [
    {
      "name": "orders",
      "attributes": { "VisibilityTimeout": "60", "DelaySeconds": "5" },
      "tags": { "env": "staging", "team": "platform" }
    },
    {
      "name": "orders-dlq"
    },
    {
      "name": "orders.fifo",
      "attributes": {
        "FifoQueue": "true",
        "ContentBasedDeduplication": "true"
      }
    },
    {
      "name": "retry-queue",
      "attributes": {
        "RedrivePolicy": "{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:000000000000:orders-dlq\",\"maxReceiveCount\":\"3\"}"
      }
    },
    {
      "name": "eu-orders",
      "region": "eu-west-1"
    }
  ]
}
```

##### `topics`

Array of topic objects.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Topic name. Use `.fifo` suffix for FIFO topics. |
| `region` | `string` | No | Override the default region for this topic. The topic's ARN will use this region. |
| `attributes` | `Record<string, string>` | No | Topic attributes (e.g., `DisplayName`). |
| `tags` | `Record<string, string>` | No | Key-value tags for the topic. |

Example:

```json
{
  "topics": [
    {
      "name": "events",
      "attributes": { "DisplayName": "Application Events" },
      "tags": { "env": "staging" }
    },
    {
      "name": "events.fifo",
      "attributes": { "FifoQueue": "true", "ContentBasedDeduplication": "true" }
    }
  ]
}
```

##### `subscriptions`

Array of subscription objects. Referenced topics and queues must be defined in the same config (or already exist on the server).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `topic` | `string` | Yes | Topic name (not ARN) to subscribe to. |
| `queue` | `string` | Yes | Queue name (not ARN) to deliver messages to. |
| `region` | `string` | No | Override the default region. The topic and queue ARNs will be resolved in this region. |
| `attributes` | `Record<string, string>` | No | Subscription attributes (see table below). |

Supported subscription attributes:

| Attribute | Values | Description |
|-----------|--------|-------------|
| `RawMessageDelivery` | `"true"` / `"false"` | Deliver the raw message body instead of the SNS envelope JSON. |
| `FilterPolicy` | JSON string | SNS filter policy for message filtering (e.g., `"{\"color\": [\"blue\"]}"`) |
| `FilterPolicyScope` | `"MessageAttributes"` / `"MessageBody"` | Whether the filter policy applies to message attributes or body. Defaults to `MessageAttributes`. |
| `RedrivePolicy` | JSON string | Subscription-level dead-letter queue config. |
| `DeliveryPolicy` | JSON string | Delivery retry policy (stored, not enforced). |
| `SubscriptionRoleArn` | ARN string | IAM role ARN for delivery (stored, not enforced). |

Example:

```json
{
  "subscriptions": [
    {
      "topic": "events",
      "queue": "orders",
      "attributes": {
        "RawMessageDelivery": "true",
        "FilterPolicy": "{\"eventType\": [\"order.created\", \"order.updated\"]}"
      }
    },
    {
      "topic": "events",
      "queue": "notifications"
    }
  ]
}
```

##### `buckets`

Array of bucket name strings.

```json
{
  "buckets": ["uploads", "exports", "temp"]
}
```

#### Message spy

`MessageSpyReader` lets you await specific events flowing through SQS, SNS, and S3 in your tests — without polling queues yourself. Inspired by `HandlerSpy` from `message-queue-toolkit`.

Enable it with the `messageSpies` option:

```typescript
const server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
```

The spy tracks events across all three services using a discriminated union on `service`:

**SQS events** (`service: 'sqs'`):
- **`published`** — message was enqueued (via SendMessage, SendMessageBatch, or SNS fan-out)
- **`consumed`** — message was deleted (via DeleteMessage / DeleteMessageBatch)
- **`dlq`** — message exceeded `maxReceiveCount` and was moved to a dead-letter queue

**SNS events** (`service: 'sns'`):
- **`published`** — message was published to a topic (before fan-out to SQS subscriptions)

**S3 events** (`service: 's3'`):
- **`uploaded`** — object was put (PutObject or CompleteMultipartUpload)
- **`downloaded`** — object was retrieved (GetObject)
- **`deleted`** — object was deleted (DeleteObject, only when key existed)
- **`copied`** — object was copied (CopyObject; also emits `uploaded` for the destination)

##### Awaiting messages

```typescript
// Wait for a specific SQS message (resolves immediately if already in buffer)
const msg = await server.spy.waitForMessage(
  (m) => m.service === "sqs" && m.body === "order.created" && m.queueName === "orders",
  "published",
);

// Wait by SQS message ID
const msg = await server.spy.waitForMessageWithId(messageId, "consumed");

// Partial object match (deep-equal on specified fields)
const msg = await server.spy.waitForMessage({ service: "sqs", queueName: "orders", status: "published" });

// Wait for an SNS publish event
const msg = await server.spy.waitForMessage({ service: "sns", topicName: "my-topic", status: "published" });

// Wait for an S3 upload event
const msg = await server.spy.waitForMessage({ service: "s3", bucket: "my-bucket", key: "file.txt", status: "uploaded" });
```

`waitForMessage` checks the buffer first (retroactive resolution). If no match is found, it returns a Promise that resolves when a matching message arrives.

##### Timeout

All `waitForMessage` and `waitForMessageWithId` calls accept an optional `timeout` parameter (ms) as the third argument. If no matching message arrives in time, the promise rejects with a timeout error — preventing tests from hanging indefinitely:

```typescript
// Reject after 2 seconds if no match
const msg = await server.spy.waitForMessage(
  { service: "sqs", queueName: "orders" },
  "published",
  2000,
);

// Also works with waitForMessageWithId
const msg = await server.spy.waitForMessageWithId(messageId, "consumed", 5000);
```

##### Waiting for multiple messages

`waitForMessages` collects `count` matching messages before resolving. It checks the buffer first, then awaits future arrivals:

```typescript
// Wait for 3 messages on the orders queue
const msgs = await server.spy.waitForMessages(
  { service: "sqs", queueName: "orders" },
  { count: 3, status: "published", timeout: 5000 },
);
// msgs.length === 3
```

If the timeout expires before enough messages arrive, the promise rejects with a message showing how many were collected (e.g., `"collected 1/3"`).

##### Negative assertions

`expectNoMessage` asserts that no matching message appears within a time window. Useful for verifying that filter policies dropped a message or that a side effect did not occur:

```typescript
// Assert no message was delivered to the wrong queue (waits 200ms by default)
await server.spy.expectNoMessage({ service: "sqs", queueName: "wrong-queue" });

// Custom window and status filter
await server.spy.expectNoMessage(
  { service: "sqs", queueName: "orders" },
  { status: "dlq", within: 500 },
);
```

If a matching message is already in the buffer, `expectNoMessage` rejects immediately. If one arrives during the wait, it rejects with `"matching message arrived during wait"`.

##### Synchronous check

```typescript
const msg = server.spy.checkForMessage(
  (m) => m.service === "sqs" && m.queueName === "my-queue",
  "published",
);
// returns SpyMessage | undefined
```

##### Buffer management

```typescript
// Get all tracked messages (oldest to newest)
const all = server.spy.getAllMessages();

// Clear buffer and reject pending waiters
server.spy.clear();
```

The buffer defaults to 100 messages (FIFO eviction). Configure with:

```typescript
const server = await startFauxqs({
  messageSpies: { bufferSize: 500 },
});
```

##### Types

`server.spy` returns a `MessageSpyReader` — a read-only interface that exposes query and await methods but not internal mutation (e.g. recording new events):

```typescript
interface MessageSpyReader {
  waitForMessage(filter: MessageSpyFilter, status?: string, timeout?: number): Promise<SpyMessage>;
  waitForMessageWithId(messageId: string, status?: string, timeout?: number): Promise<SpyMessage>;
  waitForMessages(filter: MessageSpyFilter, options: WaitForMessagesOptions): Promise<SpyMessage[]>;
  expectNoMessage(filter: MessageSpyFilter, options?: ExpectNoMessageOptions): Promise<void>;
  checkForMessage(filter: MessageSpyFilter, status?: string): SpyMessage | undefined;
  getAllMessages(): SpyMessage[];
  clear(): void;
}

interface WaitForMessagesOptions {
  count: number;
  status?: string;
  timeout?: number;
}

interface ExpectNoMessageOptions {
  status?: string;
  within?: number; // ms, defaults to 200
}
```

`SpyMessage` is a discriminated union:

```typescript
interface SqsSpyMessage {
  service: "sqs";
  queueName: string;
  messageId: string;
  body: string;
  messageAttributes: Record<string, MessageAttributeValue>;
  status: "published" | "consumed" | "dlq";
  timestamp: number;
}

interface SnsSpyMessage {
  service: "sns";
  topicArn: string;
  topicName: string;
  messageId: string;
  body: string;
  messageAttributes: Record<string, MessageAttributeValue>;
  status: "published";
  timestamp: number;
}

interface S3SpyEvent {
  service: "s3";
  bucket: string;
  key: string;
  status: "uploaded" | "downloaded" | "deleted" | "copied";
  timestamp: number;
}

type SpyMessage = SqsSpyMessage | SnsSpyMessage | S3SpyEvent;
```

##### Spy disabled by default

Accessing `server.spy` when `messageSpies` is not set throws an error. There is no overhead on the message flow when spies are disabled.

#### Queue inspection

Non-destructive inspection of SQS queue state — see all messages (ready, in-flight, and delayed) without consuming them or affecting visibility timeouts.

##### Programmatic API

```typescript
const result = server.inspectQueue("my-queue");
// result is undefined if queue doesn't exist
if (result) {
  console.log(result.name);           // "my-queue"
  console.log(result.url);            // "http://sqs.us-east-1.localhost:4566/000000000000/my-queue"
  console.log(result.arn);            // "arn:aws:sqs:us-east-1:000000000000:my-queue"
  console.log(result.attributes);     // { VisibilityTimeout: "30", ... }
  console.log(result.messages.ready);    // messages available for receive
  console.log(result.messages.delayed);  // messages waiting for delay to expire
  console.log(result.messages.inflight); // received but not yet deleted
  // Each inflight entry includes: { message, receiptHandle, visibilityDeadline }
}
```

##### HTTP endpoints

```bash
# List all queues with summary counts
curl http://localhost:4566/_fauxqs/queues
# [{ "name": "my-queue", "approximateMessageCount": 5, "approximateInflightCount": 2, "approximateDelayedCount": 0, ... }]

# Inspect a specific queue (full state)
curl http://localhost:4566/_fauxqs/queues/my-queue
# { "name": "my-queue", "messages": { "ready": [...], "delayed": [...], "inflight": [...] }, ... }
```

Returns 404 for non-existent queues. Inspection never modifies queue state — messages remain exactly where they are.

### Configurable queue URL host

Queue URLs use the AWS-style `sqs.<region>.<host>` format. The `host` defaults to `localhost`, producing URLs like `http://sqs.us-east-1.localhost:4566/000000000000/myQueue`.

To override the host (e.g., for a custom domain):

```typescript
import { startFauxqs } from "fauxqs";

const server = await startFauxqs({ port: 4566, host: "myhost.local" });
// Queue URLs: http://sqs.us-east-1.myhost.local:4566/000000000000/myQueue
```

This also works with `buildApp`:

```typescript
import { buildApp } from "fauxqs";

const app = buildApp({ host: "myhost.local" });
```

The configured host ensures queue URLs are consistent across all creation paths (init config, programmatic API, and SDK requests), regardless of the request's `Host` header.

### Region

Region is part of an entity's identity — a queue named `my-queue` in `us-east-1` is a completely different entity from `my-queue` in `eu-west-1`, just like in real AWS.

The region used in ARNs and queue URLs is automatically detected from the SDK client's `Authorization` header (AWS SigV4 credential scope). If your SDK client is configured with `region: "eu-west-1"`, all entities created or looked up through that client will use `eu-west-1` in their ARNs and URLs.

```typescript
const sqsEU = new SQSClient({ region: "eu-west-1", endpoint: "http://localhost:4566", ... });
const sqsUS = new SQSClient({ region: "us-east-1", endpoint: "http://localhost:4566", ... });

// These are two independent queues with different ARNs
await sqsEU.send(new CreateQueueCommand({ QueueName: "orders" }));
await sqsUS.send(new CreateQueueCommand({ QueueName: "orders" }));
```

If the region cannot be resolved from request headers (e.g., requests without AWS SigV4 signing), the `defaultRegion` option is used as a fallback (defaults to `"us-east-1"`):

```typescript
const server = await startFauxqs({ defaultRegion: "eu-west-1" });
```

Resources created via init config or programmatic API use the `defaultRegion` unless overridden with an explicit `region` field:

```json
{
  "queues": [
    { "name": "us-queue" },
    { "name": "eu-queue", "region": "eu-west-1" }
  ]
}
```

## Supported API Actions

### SQS

| Action | Supported |
|--------|-----------|
| CreateQueue | Yes |
| DeleteQueue | Yes |
| GetQueueUrl | Yes |
| ListQueues | Yes |
| GetQueueAttributes | Yes |
| SetQueueAttributes | Yes |
| PurgeQueue | Yes |
| SendMessage | Yes |
| SendMessageBatch | Yes |
| ReceiveMessage | Yes |
| DeleteMessage | Yes |
| DeleteMessageBatch | Yes |
| ChangeMessageVisibility | Yes |
| ChangeMessageVisibilityBatch | Yes |
| TagQueue | Yes |
| UntagQueue | Yes |
| ListQueueTags | Yes |
| AddPermission | No |
| RemovePermission | No |
| ListDeadLetterSourceQueues | No |
| StartMessageMoveTask | No |
| CancelMessageMoveTask | No |
| ListMessageMoveTasks | No |

### SNS

| Action | Supported |
|--------|-----------|
| CreateTopic | Yes |
| DeleteTopic | Yes |
| ListTopics | Yes |
| GetTopicAttributes | Yes |
| SetTopicAttributes | Yes |
| Subscribe | Yes |
| Unsubscribe | Yes |
| ConfirmSubscription | Yes |
| ListSubscriptions | Yes |
| ListSubscriptionsByTopic | Yes |
| GetSubscriptionAttributes | Yes |
| SetSubscriptionAttributes | Yes |
| Publish | Yes |
| PublishBatch | Yes |
| TagResource | Yes |
| UntagResource | Yes |
| ListTagsForResource | Yes |
| AddPermission | No |
| RemovePermission | No |
| GetDataProtectionPolicy | No |
| PutDataProtectionPolicy | No |

Platform application, SMS, and phone number actions are not supported.

### S3

| Action | Supported |
|--------|-----------|
| CreateBucket | Yes |
| HeadBucket | Yes |
| ListObjects | Yes |
| ListObjectsV2 | Yes |
| CopyObject | Yes |
| PutObject | Yes |
| GetObject | Yes |
| DeleteObject | Yes |
| HeadObject | Yes |
| DeleteObjects | Yes |
| DeleteBucket | Yes |
| ListBuckets | Yes |
| CreateMultipartUpload | Yes |
| UploadPart | Yes |
| CompleteMultipartUpload | Yes |
| AbortMultipartUpload | Yes |
| ListObjectVersions | No |
| GetBucketLocation | No |

Bucket configuration (CORS, lifecycle, encryption, replication, etc.), ACLs, versioning, tagging, and other management actions are not supported.

### STS

| Action | Supported |
|--------|-----------|
| GetCallerIdentity | Yes |
| AssumeRole | No |
| GetSessionToken | No |
| GetFederationToken | No |

Returns a mock identity with account `000000000000` and ARN `arn:aws:iam::000000000000:root`. This allows tools like Terraform and the AWS CLI that call `sts:GetCallerIdentity` on startup to work without errors. Other STS actions are not supported.

## SQS Features

- **Message attributes** with MD5 checksums matching the AWS algorithm
- **Visibility timeout** — messages become invisible after receive and reappear after timeout
- **Delay queues** — per-queue default delay and per-message delay overrides
- **Long polling** — `WaitTimeSeconds` on ReceiveMessage blocks until messages arrive or timeout
- **Dead letter queues** — messages exceeding `maxReceiveCount` are moved to the configured DLQ
- **Batch operations** — SendMessageBatch, DeleteMessageBatch, ChangeMessageVisibilityBatch with entry ID validation (`InvalidBatchEntryId`) and total batch size validation (`BatchRequestTooLong`)
- **Queue attribute range validation** — validates `VisibilityTimeout`, `DelaySeconds`, `ReceiveMessageWaitTimeSeconds`, `MaximumMessageSize`, and `MessageRetentionPeriod` on both CreateQueue and SetQueueAttributes
- **Message size validation** — rejects messages exceeding 1 MiB (1,048,576 bytes)
- **Unicode character validation** — rejects messages with characters outside the AWS-allowed set
- **KMS attributes** — `KmsMasterKeyId` and `KmsDataKeyReusePeriodSeconds` are accepted and stored (no actual encryption)
- **FIFO queues** — `.fifo` suffix enforcement, `MessageGroupId` ordering, per-group locking (one inflight message per group), `MessageDeduplicationId`, content-based deduplication, sequence numbers, and FIFO-aware DLQ support
- **Queue tags**

## SNS Features

- **SNS-to-SQS fan-out** — publish to a topic and messages are delivered to all confirmed SQS subscriptions
- **Filter policies** — both `MessageAttributes` and `MessageBody` scope, supporting exact match, prefix, suffix, anything-but (including anything-but with suffix), numeric ranges, exists, null conditions, and `$or` top-level grouping. MessageBody scope supports nested key matching
- **Raw message delivery** — configurable per subscription
- **Message size validation** — rejects messages exceeding 256 KB (262,144 bytes)
- **Topic idempotency with conflict detection** — `CreateTopic` returns the existing topic when called with the same name, attributes, and tags, but throws when attributes or tags differ
- **Subscription idempotency with conflict detection** — `Subscribe` returns the existing subscription when the same (topic, protocol, endpoint) combination is used with matching attributes, but throws when attributes differ
- **Subscription attribute validation** — `SetSubscriptionAttributes` validates attribute names and rejects unknown or read-only attributes
- **Topic and subscription tags**
- **FIFO topics** — `.fifo` suffix enforcement, `MessageGroupId` and `MessageDeduplicationId` passthrough to SQS subscriptions, content-based deduplication
- **Batch publish**

## S3 Features

- **Bucket management** — CreateBucket (idempotent), DeleteBucket (rejects non-empty), HeadBucket, ListBuckets, ListObjects (V1 and V2)
- **Object operations** — PutObject, GetObject, DeleteObject, HeadObject, CopyObject with ETag, Content-Type, and Last-Modified headers
- **Multipart uploads** — CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload with correct multipart ETag calculation (`MD5-of-part-digests-partCount`), metadata preservation, and part overwrite support
- **ListObjects V2** — prefix filtering, delimiter-based virtual directories, MaxKeys, continuation tokens, StartAfter
- **CopyObject** — same-bucket and cross-bucket copy via `x-amz-copy-source` header, with metadata preservation
- **User metadata** — `x-amz-meta-*` headers are stored and returned on GetObject and HeadObject
- **Bulk delete** — DeleteObjects for batch key deletion with proper XML entity handling
- **Keys with slashes** — full support for slash-delimited keys (e.g., `path/to/file.txt`)
- **Stream uploads** — handles AWS chunked transfer encoding (`Content-Encoding: aws-chunked`) for stream bodies
- **Path-style and virtual-hosted-style** — both S3 URL styles are supported (see below)

### S3 URL styles

The AWS SDK sends S3 requests using virtual-hosted-style URLs by default (e.g., `my-bucket.s3.localhost:4566`). This requires `*.localhost` to resolve to `127.0.0.1`. fauxqs supports several approaches.

#### Option 1: `fauxqs.dev` wildcard DNS (recommended for Docker image)

Works out of the box when running the [official Docker image](#running-with-docker) — nothing to configure. The `fauxqs.dev` domain provides wildcard DNS — `*.localhost.fauxqs.dev` resolves to `127.0.0.1` via a public DNS entry. Just use `s3.localhost.fauxqs.dev` as your endpoint. This replicates the approach [pioneered by LocalStack](https://docs.localstack.cloud/aws/services/s3/) with `localhost.localstack.cloud`: a public DNS record maps all subdomains to localhost, so virtual-hosted-style requests work without `/etc/hosts` changes, custom request handlers, or `forcePathStyle`. Works from any language, `fetch()`, or CLI tool.

```typescript
import { S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: "http://s3.localhost.fauxqs.dev:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
```

You can also use raw HTTP requests:

```bash
# Upload
curl -X PUT --data-binary @file.txt http://my-bucket.s3.localhost.fauxqs.dev:4566/file.txt

# Download
curl http://my-bucket.s3.localhost.fauxqs.dev:4566/file.txt
```

This is the recommended approach for host-to-Docker setups. If you are using fauxqs as an [embedded library](#programmatic-usage) in Node.js tests, prefer Option 2 (`interceptLocalhostDns`) instead — it patches DNS globally so all clients work without modification, and requires no external DNS.

For **container-to-container** S3 virtual-hosted-style in docker-compose, use the [built-in DNS server](#container-to-container-s3-virtual-hosted-style) instead — it resolves `*.s3.fauxqs` to the fauxqs container IP so other containers can use virtual-hosted-style S3 without `forcePathStyle`.

#### Option 2: `interceptLocalhostDns()` (recommended for embedded library)

Patches Node.js `dns.lookup` so that any hostname ending in `.localhost` resolves to `127.0.0.1`. No client changes needed.

```typescript
import { interceptLocalhostDns } from "fauxqs";

const restore = interceptLocalhostDns();

const s3 = new S3Client({
  endpoint: "http://s3.localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

// When done (e.g., in afterAll):
restore();
```

The suffix is configurable: `interceptLocalhostDns("myhost.test")` matches `*.myhost.test`.

**Tradeoffs:** Affects all DNS lookups in the process. Best suited for test suites (`beforeAll` / `afterAll`).

#### Option 3: `createLocalhostHandler()` (per-client)

Creates an HTTP request handler that resolves all hostnames to `127.0.0.1`. Scoped to a single client instance — no side effects, no external DNS dependency.

```typescript
import { S3Client } from "@aws-sdk/client-s3";
import { createLocalhostHandler } from "fauxqs";

const s3 = new S3Client({
  endpoint: "http://s3.localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  requestHandler: createLocalhostHandler(),
});
```

#### Option 4: `forcePathStyle` (simplest fallback)

Forces the SDK to use path-style URLs (`http://localhost:4566/my-bucket/key`) instead of virtual-hosted-style. No DNS or handler changes needed, but affects how the SDK resolves S3 URLs at runtime.

```typescript
const s3 = new S3Client({
  endpoint: "http://localhost:4566",
  forcePathStyle: true,
  // ...
});
```


### Using with AWS CLI

fauxqs is wire-compatible with the standard AWS CLI. Point it at the fauxqs endpoint:

#### SQS

```bash
aws --endpoint-url http://localhost:4566 sqs create-queue --queue-name my-queue
aws --endpoint-url http://localhost:4566 sqs create-queue \
  --queue-name my-queue.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/my-queue \
  --message-body "hello"
```

#### SNS

```bash
aws --endpoint-url http://localhost:4566 sns create-topic --name my-topic
aws --endpoint-url http://localhost:4566 sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:000000000000:my-topic \
  --protocol sqs \
  --notification-endpoint arn:aws:sqs:us-east-1:000000000000:my-queue
```

#### S3

```bash
aws --endpoint-url http://localhost:4566 s3 mb s3://my-bucket
aws --endpoint-url http://localhost:4566 s3 cp file.txt s3://my-bucket/file.txt
```

If the AWS CLI uses virtual-hosted-style S3 URLs by default, configure path-style:

```bash
aws configure set default.s3.addressing_style path
```

## Testing Strategies

fauxqs supports two deployment modes that complement each other for a complete testing workflow:

| Mode | Best for | Startup | Assertions |
|------|----------|---------|------------|
| **Library** (embedded) | Unit tests, integration tests, CI | Milliseconds, in-process | Full programmatic API: `sendMessage`, `publish`, `spy`, `inspectQueue`, `reset`, `purgeAll` |
| **Docker** (standalone) | Local development, acceptance tests, dev environments | Seconds, real HTTP | Init config, HTTP inspection endpoints |

### Library mode for tests

Embed fauxqs directly in your test suite. Each test file gets its own server instance on a random port — no Docker dependency, no shared state, no port conflicts:

```typescript
// test/setup.ts
import { startFauxqs, type FauxqsServer } from "fauxqs";

export async function createTestServer(): Promise<FauxqsServer> {
  const server = await startFauxqs({ port: 0, logger: false, messageSpies: true });

  // Pre-create resources via the programmatic API (no SDK roundtrips)
  server.createQueue("my-queue");
  server.createBucket("my-bucket");

  return server;
}
```

```typescript
// test/app.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

let server: FauxqsServer;

beforeAll(async () => { server = await createTestServer(); });
afterAll(async () => { await server.stop(); });
beforeEach(() => { server.spy.clear(); });

it("tracks uploads via the spy", async () => {
  // ... trigger your app logic that uploads to S3 ...

  const event = await server.spy.waitForMessage(
    { service: "s3", bucket: "my-bucket", key: "file.txt", status: "uploaded" },
    undefined,
    2000, // timeout — prevents tests from hanging
  );
  expect(event.status).toBe("uploaded");
});
```

Library mode gives you deterministic assertions via the [message spy](#message-spy), non-destructive state inspection via [`inspectQueue()`](#queue-inspection), and instant state reset with `reset()` / `purgeAll()` — none of which are available from outside the process.

### Docker mode for local development

Use `docker-compose.yml` with an init config to give your team a consistent local environment:

```yaml
# docker-compose.yml
services:
  fauxqs:
    image: kibertoad/fauxqs:latest
    ports: ["4566:4566"]
    environment:
      - FAUXQS_INIT=/app/init.json
    volumes:
      - ./fauxqs-init.json:/app/init.json

  app:
    build: .
    depends_on:
      fauxqs:
        condition: service_healthy
    environment:
      - AWS_ENDPOINT=http://fauxqs:4566
```

Docker mode validates your real deployment topology — networking, DNS, container-to-container communication — and is language-agnostic (any AWS SDK can connect).

### Recommended combination

Use both modes together. Library mode runs in CI on every commit (fast, no Docker required). Docker mode runs locally via `docker compose up` and optionally in a separate CI stage for acceptance testing.

See the [`examples/recommended/`](examples/recommended/) directory for a complete working example with a Fastify app, library-mode vitest tests, and Docker compose configuration.

## Conventions

- Account ID: `000000000000`
- Region: auto-detected from SDK `Authorization` header; falls back to `defaultRegion` (defaults to `us-east-1`). Region is part of entity identity — same-name entities in different regions are independent.
- Queue URL format: `http://sqs.{region}.{host}:{port}/000000000000/{queueName}` (host defaults to `localhost`)
- Queue ARN format: `arn:aws:sqs:{region}:000000000000:{queueName}`
- Topic ARN format: `arn:aws:sns:{region}:000000000000:{topicName}`

## Limitations

fauxqs is designed for development and testing. It does not support:

- Non-SQS SNS delivery protocols (HTTP/S, Lambda, email, SMS)
- Persistence across restarts
- Authentication or authorization
- Cross-account operations

## Examples

The [`examples/`](examples/) directory contains runnable TypeScript examples covering fauxqs-specific features beyond standard AWS SDK usage:

| Example | Description |
|---------|-------------|
| [`alternatives/programmatic/programmatic-api.ts`](examples/alternatives/programmatic/programmatic-api.ts) | Server lifecycle, resource creation, SDK usage, `inspectQueue()`, `reset()`, `purgeAll()`, `setup()` |
| [`alternatives/programmatic/message-spy.ts`](examples/alternatives/programmatic/message-spy.ts) | `MessageSpyReader` — all spy methods, partial/predicate filters, discriminated union narrowing, DLQ tracking |
| [`alternatives/programmatic/init-config.ts`](examples/alternatives/programmatic/init-config.ts) | File-based and inline init config, DLQ chains, `setup()` idempotency, purge + re-apply pattern |
| [`alternatives/programmatic/queue-inspection.ts`](examples/alternatives/programmatic/queue-inspection.ts) | Programmatic `inspectQueue()` and HTTP `/_fauxqs/queues` endpoints |
| [`alternatives/docker/standalone/`](examples/alternatives/docker/standalone/standalone-container.ts) | Connecting to a fauxqs Docker container from the host |
| [`alternatives/docker/container-to-container/`](examples/alternatives/docker/container-to-container/) | Container-to-container communication via docker-compose |
| [`recommended/`](examples/recommended/) | Dual-mode testing: library mode (vitest + spy) for CI, Docker for local dev |

All examples are type-checked in CI to prevent staleness.

## Migrating from LocalStack

If you're currently using LocalStack for local SNS, SQS, and/or S3 emulation, fauxqs is a drop-in replacement for those services. Both listen on port 4566 by default and accept the same AWS SDK calls, so the migration is straightforward.

There are two approaches: a Docker swap (quickest) and a hybrid setup (recommended for the best integration test experience). Which one makes sense depends on whether you use S3.

### SNS/SQS only

If your LocalStack usage is limited to SNS and SQS, the migration is a one-line Docker image swap. No SDK client changes are needed — the endpoint URL, port, and credentials stay the same.

**Docker swap:**

```yaml
# Before (LocalStack)
services:
  localstack:
    image: localstack/localstack
    ports: ["4566:4566"]
    environment:
      - SERVICES=sqs,sns

# After (fauxqs)
services:
  fauxqs:
    image: kibertoad/fauxqs:latest
    ports: ["4566:4566"]
```

**Region:** Both LocalStack and fauxqs auto-detect the region from the SDK client's `Authorization` header, so in most setups no configuration is needed. If you have older LocalStack configs that used the now-removed `DEFAULT_REGION` env var (deprecated in v0.12.7, removed in v2.0), the equivalent in fauxqs is `FAUXQS_DEFAULT_REGION` — it serves as a fallback when the region can't be resolved from request headers. Both default to `us-east-1`.

The main difference is how resources are pre-created. LocalStack uses init hooks (`/etc/localstack/init/ready.d/` shell scripts with `awslocal` CLI calls), while fauxqs uses a declarative JSON config. `awslocal` defaults to `us-east-1` unless you pass `--region`, and fauxqs init config uses `defaultRegion` (`us-east-1`) unless you set an explicit `region` per resource — so both create resources in the same region by default:

```bash
# LocalStack init script (ready.d/init.sh)
# awslocal defaults to us-east-1; use --region to override
awslocal sqs create-queue --queue-name orders
awslocal sqs create-queue --queue-name orders-dlq
awslocal sns create-topic --name events
awslocal sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:000000000000:events \
  --protocol sqs \
  --notification-endpoint arn:aws:sqs:us-east-1:000000000000:orders
```

```json
// fauxqs init.json — uses defaultRegion (us-east-1) unless "region" is set per resource
{
  "queues": [{ "name": "orders" }, { "name": "orders-dlq" }],
  "topics": [{ "name": "events" }],
  "subscriptions": [{ "topic": "events", "queue": "orders" }]
}
```

```yaml
# Before (LocalStack docker-compose.yml)
services:
  localstack:
    image: localstack/localstack
    ports: ["4566:4566"]
    environment:
      - SERVICES=sqs,sns
    volumes:
      - ./ready.d:/etc/localstack/init/ready.d

# After (fauxqs docker-compose.yml)
services:
  fauxqs:
    image: kibertoad/fauxqs:latest
    ports: ["4566:4566"]
    environment:
      - FAUXQS_INIT=/app/init.json
    volumes:
      - ./init.json:/app/init.json
```

Update your docker-compose service name references (e.g., `http://localstack:4566` to `http://fauxqs:4566`) and you're done.

### SNS/SQS/S3

When S3 is involved, the Docker swap is still straightforward — the only additional consideration is S3 URL style. If you were using `forcePathStyle: true` with LocalStack, it works identically with fauxqs. If you were using LocalStack's `localhost.localstack.cloud` wildcard DNS for virtual-hosted-style, switch to `localhost.fauxqs.dev`:

```typescript
// Before (LocalStack)
const s3 = new S3Client({
  endpoint: "http://s3.localhost.localstack.cloud:4566",
  // ...
});

// After (fauxqs)
const s3 = new S3Client({
  endpoint: "http://s3.localhost.fauxqs.dev:4566",
  // ...
});
```

For container-to-container S3 in docker-compose, fauxqs includes a built-in dnsmasq that resolves `*.s3.fauxqs` to the container IP — see [Container-to-container S3 virtual-hosted-style](#container-to-container-s3-virtual-hosted-style).

The init config for S3 is the same declarative JSON, with a `buckets` array:

```json
{
  "queues": [{ "name": "orders" }],
  "topics": [{ "name": "events" }],
  "subscriptions": [{ "topic": "events", "queue": "orders" }],
  "buckets": ["uploads", "exports"]
}
```

### Going hybrid (recommended)

The Docker swap gets you running quickly, but the real win comes from going hybrid: use fauxqs as an **embedded library** in your test suite and keep Docker for local development.

With LocalStack, integration tests typically look like this:

1. Start LocalStack container (docker-compose or testcontainers) — takes seconds
2. Create resources via `awslocal` or SDK calls — more seconds
3. Run your test logic
4. Assert by polling SQS queues, checking S3 objects, etc.
5. Clean up resources between tests — often fragile or skipped

With fauxqs in library mode:

1. `startFauxqs({ port: 0 })` — starts in milliseconds, in-process
2. `server.setup({ queues: [...], topics: [...] })` — instant, no network calls
3. Run your test logic
4. Assert with `server.spy.waitForMessage()` — no polling, no race conditions
5. `server.reset()` between tests — clears messages, keeps resources

**What you gain:**

| Concern | LocalStack Docker | fauxqs library mode |
|---------|-------------------|---------------------|
| Test startup | Seconds (container boot + resource creation) | Milliseconds (in-process) |
| CI dependency | Docker required | npm only |
| Asserting message delivery | Poll SQS queue, hope timing is right | `spy.waitForMessage()` — resolves immediately or waits |
| Asserting message *not* delivered | `sleep()` + check | `spy.expectNoMessage()` — deterministic negative assertion |
| Filter policy testing | Receive from queue, check absence manually | `expectNoMessage()` on filtered-out queues |
| DLQ verification | Receive from DLQ queue via SDK | `spy.waitForMessage({ status: "dlq" })` + `inspectQueue()` |
| Queue state inspection | `GetQueueAttributes` (counts only) | `inspectQueue()` — see every message, grouped by state |
| State reset between tests | Restart container or re-create resources | `server.reset()` — instant, preserves resource definitions |
| Seeding test data | SDK calls through network stack | `server.sendMessage()` / `server.publish()` — direct, no network |
| S3 event tracking | Check bucket contents via SDK | `spy.waitForMessage({ service: "s3", status: "uploaded" })` |
| Parallel test files | Port conflicts or shared state | Each file gets its own server on port 0 |

**Migration path:**

1. Install fauxqs as a dev dependency: `npm install -D fauxqs`
2. Create a test helper:

```typescript
// test/setup.ts
import { startFauxqs, type FauxqsServer } from "fauxqs";

export async function createTestServer(): Promise<FauxqsServer> {
  const server = await startFauxqs({ port: 0, logger: false, messageSpies: true });

  server.setup({
    queues: [{ name: "orders" }, { name: "orders-dlq" }],
    topics: [{ name: "events" }],
    subscriptions: [{ topic: "events", queue: "orders" }],
    buckets: ["uploads"],
  });

  return server;
}
```

3. Replace your LocalStack container setup with the test helper:

```typescript
// Before: LocalStack via testcontainers or docker-compose
let endpoint: string;
beforeAll(async () => {
  // start container, wait for health, create resources via SDK...
  endpoint = "http://localhost:4566";
}, 30_000);

// After: fauxqs library
let server: FauxqsServer;
beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => { await server.stop(); });
beforeEach(() => { server.reset(); });
```

4. Replace polling-based assertions with spy-based ones:

```typescript
// Before: poll and hope
await sqsClient.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "test" }));
const result = await sqsClient.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 5 }));
expect(result.Messages?.[0]?.Body).toBe("test");

// After: spy knows immediately
await sqsClient.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "test" }));
const msg = await server.spy.waitForMessage(
  { service: "sqs", queueName: "orders", status: "published" },
  undefined,
  2000,
);
expect(msg.body).toBe("test");
```

5. Keep your `docker-compose.yml` with the fauxqs image for local development — `docker compose up` gives your team a running environment without Node.js installed.

This hybrid setup gives you fast, deterministic tests in CI (no Docker required) and a realistic Docker environment for local development. See the [`examples/recommended/`](examples/recommended/) directory for a complete working example.

## Benchmarks

SQS throughput benchmarks are available in the [`benchmarks/`](benchmarks/) directory, comparing fauxqs across different deployment modes (in-process library, official Docker image, lightweight Docker container) and against LocalStack. See [`benchmarks/BENCHMARKING.md`](benchmarks/BENCHMARKING.md) for setup descriptions, instructions, and how to interpret results.

## License

MIT
