# fauxqs

Local SNS/SQS/S3 emulator for development and testing. Applications using `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`, and `@aws-sdk/client-s3` can point to this server instead of real AWS or LocalStack.

## Quick Start

```bash
npm run dev      # Start server on port 3000
npm test         # Run tests
npm run test:coverage  # Run tests with coverage
```

Configure AWS SDK clients:
```typescript
new SQSClient({ endpoint: "http://localhost:3000", region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } })
new SNSClient({ endpoint: "http://localhost:3000", region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } })
new S3Client({ endpoint: "http://localhost:3000", region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" }, forcePathStyle: true })
```

## Architecture

Single Fastify server handles SQS, SNS, and S3 on one port. Requests are dispatched by `Content-Type` and route:
- `POST /` with `application/x-amz-json-1.0` → SQS (JSON protocol, `X-Amz-Target` header)
- `POST /` with `application/x-www-form-urlencoded` → SNS (Query/XML protocol, `Action` param)
- `PUT/GET/HEAD/DELETE /:bucket/*` → S3 (REST protocol, HTTP method + URL path)

All state is in-memory. No persistence.

## Project Structure

```
src/
  app.ts                     # Fastify app setup, content-type routing, handler registration
  server.ts                  # Entry point (listen on port 3000)
  common/
    types.ts                 # Constants: DEFAULT_ACCOUNT_ID, DEFAULT_REGION
    errors.ts                # SqsError, SnsError, S3Error classes
    arnHelper.ts             # ARN generation (sqsQueueArn, snsTopicArn, etc.)
    md5.ts                   # MD5 of message body + message attributes (AWS algorithm)
    xml.ts                   # XML response helpers for SNS Query protocol
  sqs/
    sqsStore.ts              # SqsQueue class (message ops) + SqsStore class (queue collection)
    sqsRouter.ts             # X-Amz-Target dispatcher
    sqsTypes.ts              # Interfaces, default attributes, constants
    actions/                 # One file per SQS API action
  sns/
    snsStore.ts              # SnsStore: topics + subscriptions
    snsRouter.ts             # Action param dispatcher
    snsTypes.ts              # Interfaces
    filter.ts                # SNS filter policy evaluation engine
    actions/                 # One file per SNS API action
  s3/
    s3Store.ts               # S3Store: buckets + objects in Maps
    s3Router.ts              # REST route registration (/:bucket, /:bucket/*)
    s3Types.ts               # S3Object interface
    actions/                 # One file per S3 API action
test/
  helpers/
    clients.ts               # SQS/SNS/S3 client factories for tests
    setup.ts                 # createTestServer() helper
  sqs/                       # SQS integration tests (real SDK against server)
  sns/                       # SNS integration tests
  s3/                        # S3 integration tests
```

## Key Design Decisions

- **Handler pattern**: Each action is a standalone function in `actions/`. Handlers are registered on the router in `app.ts`. This makes it easy to add new actions without modifying existing code.
- **SqsQueue owns messages**: The `SqsQueue` class has `enqueue()`, `dequeue()`, `deleteMessage()`, `changeVisibility()`, `processTimers()`, and `waitForMessages()`. The store is just a collection of queues.
- **Lazy timer processing**: Visibility timeout expiration and delayed message promotion happen lazily on each `dequeue()` call rather than via a background interval. This keeps tests deterministic.
- **Long polling**: Uses a waiter pattern. `waitForMessages()` returns a Promise that resolves when messages arrive or timeout expires. `enqueue()` notifies waiters via `notifyWaiters()`.
- **DLQ**: Checked during `dequeue()`. When `approximateReceiveCount > maxReceiveCount`, the message is moved to the DLQ queue (resolved by ARN).
- **SNS→SQS fan-out**: `publish.ts` iterates confirmed SQS subscriptions, evaluates filter policies, and enqueues into the target SQS queue directly (both wrapped envelope and raw delivery).
- **Filter policies**: Evaluated as a pure function in `filter.ts`. Supports exact match, prefix, suffix, anything-but, numeric ranges, and exists. AND between top-level keys, OR within arrays. Supports both `MessageAttributes` and `MessageBody` scope.
- **S3 store**: Simple Map-based store. `buckets: Map<string, Map<string, S3Object>>`. CreateBucket is idempotent, DeleteObject silently succeeds for missing keys. ETag is quoted MD5 hex of object body.

## Protocols

### SQS (JSON)
- All requests: `POST /` with `Content-Type: application/x-amz-json-1.0`
- Action in `X-Amz-Target: AmazonSQS.<ActionName>` header
- JSON request/response bodies
- Errors: `{ "__type": "com.amazonaws.sqs#ErrorCode", "message": "..." }` with `x-amzn-query-error` header

### SNS (Query/XML)
- All requests: `POST /` with `Content-Type: application/x-www-form-urlencoded`
- Action in `Action` form param
- XML responses wrapped in `<{Action}Response>` / `<{Action}Result>`
- Complex params use dotted notation: `Tags.member.1.Key=k1`

### S3 (REST)
- Uses HTTP method + URL path to determine action
- `PUT /:bucket` → CreateBucket, `HEAD /:bucket` → HeadBucket, `GET /:bucket` → ListObjects
- `PUT /:bucket/:key` → PutObject, `GET /:bucket/:key` → GetObject, `DELETE /:bucket/:key` → DeleteObject, `HEAD /:bucket/:key` → HeadObject
- `POST /:bucket?delete` → DeleteObjects (bulk delete via XML body)
- XML responses for list/delete/error operations
- SDK must use `forcePathStyle: true` for local emulators

## Conventions

- Account ID: `000000000000`
- Region: `us-east-1`
- Queue URL format: `http://{host}:{port}/000000000000/{queueName}`
- Queue ARN format: `arn:aws:sqs:us-east-1:000000000000:{queueName}`
- Topic ARN format: `arn:aws:sns:us-east-1:000000000000:{topicName}`
- Auth: All credentials accepted, never validated

## Testing

Tests use `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`, and `@aws-sdk/client-s3` pointed at a Fastify test server (`startFauxqsTestServer()` in `test/helpers/setup.ts`). Each test file gets its own server instance on a random port.

Logger is disabled in tests (`buildApp({ logger: false })`) to keep output clean.

Coverage thresholds: 70% statements/functions/lines, 50% branches.

## Out of Scope

See `OUT_OF_SCOPE.md` for the full list. Key exclusions: FIFO queues/topics, non-SQS SNS delivery (HTTP, Lambda, SMS), persistence, auth validation, message size limits.
