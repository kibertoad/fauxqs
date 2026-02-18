# fauxqs

Local SNS/SQS/S3 emulator for development and testing. Point your `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`, and `@aws-sdk/client-s3` clients at fauxqs instead of real AWS or LocalStack.

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

The server starts on port `4566` (same as LocalStack) and handles SQS, SNS, and S3 on a single endpoint.

Override the port with the `FAUXQS_PORT` environment variable:

```bash
FAUXQS_PORT=3000 npx fauxqs
```

A health check is available at `GET /health`.

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

const s3Client = new S3Client({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  forcePathStyle: true,
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

### S3

| Action | Supported |
|--------|-----------|
| CreateBucket | Yes |
| HeadBucket | Yes |
| ListObjects | Yes |
| PutObject | Yes |
| GetObject | Yes |
| DeleteObject | Yes |
| HeadObject | Yes |
| DeleteObjects | Yes |

### STS

| Action | Supported |
|--------|-----------|
| GetCallerIdentity | Yes |

Returns a mock identity with account `000000000000` and ARN `arn:aws:iam::000000000000:root`. This allows tools like Terraform and the AWS CLI that call `sts:GetCallerIdentity` on startup to work without errors.

## SQS Features

- **Message attributes** with MD5 checksums matching the AWS algorithm
- **Visibility timeout** — messages become invisible after receive and reappear after timeout
- **Delay queues** — per-queue default delay and per-message delay overrides
- **Long polling** — `WaitTimeSeconds` on ReceiveMessage blocks until messages arrive or timeout
- **Dead letter queues** — messages exceeding `maxReceiveCount` are moved to the configured DLQ
- **Batch operations** — SendMessageBatch, DeleteMessageBatch, ChangeMessageVisibilityBatch
- **Message size validation** — rejects messages exceeding 1 MiB (1,048,576 bytes)
- **Unicode character validation** — rejects messages with characters outside the AWS-allowed set
- **KMS attributes** — `KmsMasterKeyId` and `KmsDataKeyReusePeriodSeconds` are accepted and stored (no actual encryption)
- **FIFO queues** — `.fifo` suffix enforcement, `MessageGroupId` ordering, per-group locking (one inflight message per group), `MessageDeduplicationId`, content-based deduplication, sequence numbers, and FIFO-aware DLQ support
- **Queue tags**

## SNS Features

- **SNS-to-SQS fan-out** — publish to a topic and messages are delivered to all confirmed SQS subscriptions
- **Filter policies** — both `MessageAttributes` and `MessageBody` scope, supporting exact match, prefix, suffix, anything-but, numeric ranges, and exists
- **Raw message delivery** — configurable per subscription
- **Message size validation** — rejects messages exceeding 256 KB (262,144 bytes)
- **Topic and subscription tags**
- **FIFO topics** — `.fifo` suffix enforcement, `MessageGroupId` and `MessageDeduplicationId` passthrough to SQS subscriptions, content-based deduplication
- **Batch publish**

## S3 Features

- **Bucket management** — CreateBucket (idempotent), HeadBucket, ListObjects
- **Object operations** — PutObject, GetObject, DeleteObject, HeadObject with ETag, Content-Type, and Last-Modified headers
- **Bulk delete** — DeleteObjects for batch key deletion
- **Keys with slashes** — full support for slash-delimited keys (e.g., `path/to/file.txt`)
- **Path-style access** — SDK must use `forcePathStyle: true`

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
