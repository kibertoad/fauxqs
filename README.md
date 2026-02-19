# fauxqs

Local SNS/SQS/S3 emulator for development and testing. Point your `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`, and `@aws-sdk/client-s3` clients at fauxqs instead of real AWS.

All state is in-memory. No persistence, no external storage dependencies.

## Installation

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
| `FAUXQS_HOST` | Host for queue URLs (enables `sqs.<region>.<host>` format) | (none) |
| `FAUXQS_DEFAULT_REGION` | Fallback region for ARNs and URLs | `us-east-1` |
| `FAUXQS_LOGGER` | Enable request logging (`true`/`false`) | `true` |
| `FAUXQS_INIT` | Path to a JSON init config file (see [Init config file](#init-config-file)) | (none) |

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

### Configuring AWS SDK clients

Point your SDK clients at the local server:

```typescript
import { SQSClient } from "@aws-sdk/client-sqs";
import { SNSClient } from "@aws-sdk/client-sns";
import { S3Client } from "@aws-sdk/client-s3";
import { createLocalhostHandler } from "fauxqs";

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

const s3Client = new S3Client({
  endpoint: "http://s3.localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  requestHandler: createLocalhostHandler(),
});
```

Any credentials are accepted and never validated.

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

// Create individual resources
server.createQueue("my-queue");
server.createQueue("my-dlq", {
  attributes: { VisibilityTimeout: "60" },
  tags: { env: "test" },
});
server.createTopic("my-topic");
server.subscribe({ topic: "my-topic", queue: "my-queue" });
server.createBucket("my-bucket");

// Or create everything at once
server.setup({
  queues: [
    { name: "orders" },
    { name: "notifications", attributes: { DelaySeconds: "5" } },
  ],
  topics: [{ name: "events" }],
  subscriptions: [
    { topic: "events", queue: "orders" },
    { topic: "events", queue: "notifications" },
  ],
  buckets: ["uploads", "exports"],
});

// Reset all state between tests
server.purgeAll();
```

#### Init config file

Create a JSON file to pre-create resources on startup:

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

### Configurable queue URL host

By default, queue URLs use the request's `Host` header (e.g., `http://127.0.0.1:4566/000000000000/myQueue`). To match the AWS-style `sqs.<region>.<host>` format, pass the `host` option:

```typescript
import { startFauxqs } from "fauxqs";

const server = await startFauxqs({ port: 4566, host: "localhost" });
// Queue URLs: http://sqs.us-east-1.localhost:4566/000000000000/myQueue
```

This also works with `buildApp`:

```typescript
import { buildApp } from "fauxqs";

const app = buildApp({ host: "localhost" });
```

### Region

The region used in ARNs and queue URLs is automatically detected from the SDK client's `Authorization` header. If your SDK client is configured with `region: "eu-west-1"`, fauxqs will use that region in all generated ARNs and URLs.

If the region cannot be resolved from request headers (e.g., requests without AWS SigV4 signing), the `defaultRegion` option is used as a fallback (defaults to `"us-east-1"`):

```typescript
const server = await startFauxqs({ defaultRegion: "eu-west-1" });
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

The AWS SDK sends S3 requests using virtual-hosted-style URLs by default (e.g., `my-bucket.s3.localhost:4566`). This requires `*.localhost` to resolve to `127.0.0.1`. fauxqs provides helpers for this, plus a simple fallback.

#### Option 1: `createLocalhostHandler()` (recommended)

Creates an HTTP request handler that resolves all hostnames to `127.0.0.1`. Scoped to a single client instance — no side effects.

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

#### Option 2: `interceptLocalhostDns()` (global, for test suites)

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

#### Option 3: `forcePathStyle` (simplest fallback)

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

## Conventions

- Account ID: `000000000000`
- Region: auto-detected from SDK `Authorization` header (defaults to `us-east-1`)
- Queue URL format: `http://{host}:{port}/000000000000/{queueName}` (or `http://sqs.{region}.{host}:{port}/000000000000/{queueName}` when `host` is configured)
- Queue ARN format: `arn:aws:sqs:{region}:000000000000:{queueName}`
- Topic ARN format: `arn:aws:sns:{region}:000000000000:{topicName}`

## Limitations

fauxqs is designed for development and testing. It does not support:

- Non-SQS SNS delivery protocols (HTTP/S, Lambda, email, SMS)
- Persistence across restarts
- Authentication or authorization
- Cross-region or cross-account operations

## License

MIT
