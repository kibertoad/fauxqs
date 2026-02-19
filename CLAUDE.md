# fauxqs

Local SNS/SQS/S3 emulator for development and testing. Applications using `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`, and `@aws-sdk/client-s3` can point to this server instead of real AWS.

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
  app.ts                     # Fastify app setup, content-type routing, handler registration, FauxqsServer API
  server.ts                  # Entry point (listen on port 3000)
  initConfig.ts              # FauxqsInitConfig type, loadInitConfig(), applyInitConfig()
  spy.ts                     # MessageSpyReader (public) + MessageSpy (internal): tracks SQS/SNS/S3 events via discriminated union
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
  localhost.ts               # Virtual-hosted-style S3 helpers (createLocalhostHandler, interceptLocalhostDns)
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
docker/
  entrypoint.sh              # Docker entrypoint: starts dnsmasq (wildcard DNS for container-to-container S3), then execs node
docker-acceptance/
  docker-acceptance.ts       # Standalone Docker acceptance test (builds image, runs S3 virtual-hosted-style tests via fauxqs.dev DNS)
  docker-compose-acceptance.ts  # Compose-based acceptance test orchestrator (container-to-container S3+SQS via dnsmasq)
  docker-compose.test.yml    # Compose file for container-to-container acceptance test
  init.json                  # Init config for acceptance test (pre-creates queue + bucket)
  test-app/                  # Test container that exercises S3 virtual-hosted-style + SQS via dnsmasq DNS
.github/workflows/
  ci.yml                     # CI pipeline
  publish.yml                # npm publish on PR merge with version label
  docker-publish.yml         # Docker Hub publish on v* tags (multi-platform: amd64+arm64)
  ensure-labels.yml          # PR label enforcement
```

## Key Design Decisions

- **Handler pattern**: Each action is a standalone function in `actions/`. Handlers are registered on the router in `app.ts`. This makes it easy to add new actions without modifying existing code.
- **SqsQueue owns messages**: The `SqsQueue` class has `enqueue()`, `dequeue()`, `deleteMessage()`, `changeVisibility()`, `processTimers()`, and `waitForMessages()`. The store is just a collection of queues.
- **Timer processing**: Visibility timeout expiration and delayed message promotion happen lazily on each `dequeue()` call. During long-poll waits (`waitForMessages`), a 20ms background interval calls `processTimers()` so that delayed messages and visibility-timeout-expired messages become available without waiting for the next explicit dequeue.
- **Long polling**: Uses a waiter pattern. `waitForMessages()` returns a Promise that resolves when messages arrive or timeout expires. `enqueue()` notifies waiters via `notifyWaiters()`.
- **DLQ**: Checked during `dequeue()`. When `approximateReceiveCount > maxReceiveCount`, the message is moved to the DLQ queue (resolved by ARN).
- **ReceiveMessage attribute merging**: `ReceiveMessage` merges both `AttributeNames` (legacy) and `MessageSystemAttributeNames` (modern) arrays. This is important because sqs-consumer and newer SDKs send `MessageSystemAttributeNames` while also sending an empty `AttributeNames: []`.
- **SNS→SQS fan-out**: `publish.ts` iterates confirmed SQS subscriptions, evaluates filter policies, and enqueues into the target SQS queue directly (both wrapped envelope and raw delivery).
- **Filter policies**: Evaluated as a pure function in `filter.ts`. Supports exact match, prefix, suffix, anything-but (including `prefix` and `suffix` sub-operators), numeric ranges, exists, and `$or` top-level key for OR logic between key groups. AND between top-level keys, OR within arrays. Supports both `MessageAttributes` and `MessageBody` scope (with nested key matching for MessageBody).
- **SNS topic idempotency**: `createTopic` in `snsStore.ts` returns the existing topic when called with the same name and matching attributes and tags. Throws `SnsError` when attributes or tags differ.
- **SNS subscription idempotency**: `subscribe` in `snsStore.ts` finds existing subscriptions by (topicArn, protocol, endpoint). Returns the existing subscription when attributes match. Throws `SnsError` when attributes differ.
- **SubscriptionPrincipal**: `GetSubscriptionAttributes` includes `SubscriptionPrincipal` (`arn:aws:iam::000000000000:user/local`) in the response, matching AWS behavior.
- **SNS subscription attribute validation**: `setSubscriptionAttributes` only allows: `RawMessageDelivery`, `FilterPolicy`, `FilterPolicyScope`, `RedrivePolicy`, `DeliveryPolicy`, `SubscriptionRoleArn`. Invalid attribute names are rejected.
- **SQS queue attribute validation**: `createQueue` and `setQueueAttributes` validate attribute ranges (VisibilityTimeout 0-43200, DelaySeconds 0-900, ReceiveMessageWaitTimeSeconds 0-20, MaximumMessageSize 1024-1048576, MessageRetentionPeriod 60-1209600). `ReceiveMessage` validates MaxNumberOfMessages 1-10.
- **SQS batch validation**: `sendMessageBatch` validates entry IDs (alphanumeric/hyphen/underscore only) and rejects batches where total size across all entries exceeds 1 MiB.
- **S3 store**: Map-based store. `buckets: Map<string, Map<string, S3Object>>` for objects, `bucketCreationDates: Map<string, Date>` for ListBuckets, `multipartUploads: Map<string, MultipartUpload>` for in-progress multipart uploads. CreateBucket is idempotent, DeleteBucket rejects non-empty buckets (including those with active multipart uploads), DeleteObject silently succeeds for missing keys but returns `NoSuchBucket` for non-existent buckets. ETag is quoted MD5 hex of object body. Multipart ETag is `"MD5-of-concatenated-part-digests-partCount"`. S3Object supports user metadata (`x-amz-meta-*` headers).
- **Multipart upload routing**: The S3 router differentiates multipart operations from regular operations using query parameters: `?uploads` for CreateMultipartUpload, `?uploadId=&partNumber=` for UploadPart, `?uploadId=` on POST for CompleteMultipartUpload, `?uploadId=` on DELETE for AbortMultipartUpload.
- **Env vars**: `startFauxqs` reads `FAUXQS_PORT`, `FAUXQS_HOST`, `FAUXQS_DEFAULT_REGION`, `FAUXQS_LOGGER`, and `FAUXQS_INIT` as fallbacks. Programmatic options take precedence over env vars.
- **Init config**: `FAUXQS_INIT` (or the `init` option) points to a JSON file (or inline object) that pre-creates queues, topics, subscriptions, and buckets on startup. Resources are created in dependency order: queues first, then topics, then subscriptions, then buckets.
- **Programmatic API**: `FauxqsServer` exposes `createQueue()`, `createTopic()`, `subscribe()`, `createBucket()`, `setup()`, `purgeAll()`, and `inspectQueue()` for state management and debugging without going through the SDK. `buildApp` accepts an optional `stores` parameter to use pre-created store instances.
- **Store purgeAll**: Each store class (`SqsStore`, `SnsStore`, `S3Store`) has a `purgeAll()` method that clears all state. `SqsStore.purgeAll()` also cancels active poll waiters.
- **Presigned URLs**: Supported for all S3 operations (GET, PUT, HEAD, DELETE). Since fauxqs never validates signatures, the `X-Amz-*` query parameters in presigned URLs are simply ignored. Fastify's default `application/json` and `text/plain` content-type parsers are removed so that S3 PUT requests with any content-type are correctly handled as raw binary via the wildcard `*` buffer parser.
- **MessageSpy**: Optional spy (`messageSpies` option on `startFauxqs`) that tracks events flowing through SQS, SNS, and S3 using a discriminated union on `service`. `spy.ts` exposes two types: `MessageSpyReader` (public read-only interface with `waitForMessage`, `waitForMessageWithId`, `waitForMessages`, `expectNoMessage`, `checkForMessage`, `getAllMessages`, `clear`) and `MessageSpy` (internal class that implements `MessageSpyReader` and adds `addMessage`). `FauxqsServer.spy` returns `MessageSpyReader` so consumers cannot mutate spy state. Stores use the internal `MessageSpy` class to record events. Fixed-size buffer (default 100, FIFO eviction) and pending waiter list. `SpyMessage = SqsSpyMessage | SnsSpyMessage | S3SpyEvent`. **SQS** (`service: 'sqs'`): `SqsQueue.enqueue()` emits `published`, `SqsQueue.deleteMessage()` emits `consumed`, DLQ paths in `dequeue()`/`dequeueFifo()` emit `dlq`. `SqsStore.spy` is propagated to each queue via `createQueue()`. **SNS** (`service: 'sns'`): `publish()` and `publishBatch()` in `sns/actions/publish.ts` emit `published` with topicArn, topicName, messageId, body, messageAttributes. `SnsStore.spy` is set from `app.ts`. **S3** (`service: 's3'`): `S3Store.putObject()` emits `uploaded`, `getObject()` emits `downloaded`, `deleteObject()` emits `deleted` (only when key exists), `completeMultipartUpload()` emits `uploaded`. CopyObject in `s3/actions/putObject.ts` emits `copied` (in addition to the `uploaded` from the store-level `putObject`). `S3Store.spy` is set from `app.ts`. `waitForMessage()` checks the buffer first (retroactive resolution) then registers a pending promise (future awaiting). Filter can be a predicate function or a partial-object matcher. Disabled by default with zero overhead — `server.spy` throws if not enabled.
  - **waitForMessage timeout**: All `waitForMessage` and `waitForMessageWithId` calls accept an optional `timeout` (ms) parameter. If no matching message arrives in time, the promise rejects with a timeout error. Prevents tests from hanging indefinitely.
  - **waitForMessages**: `waitForMessages(filter, { count, status?, timeout? })` collects `count` matching messages (retroactive + future). Rejects on timeout with a message showing how many were collected vs. expected.
  - **expectNoMessage**: `expectNoMessage(filter, { status?, within? })` is a negative assertion — resolves if no matching message appears within the time window (default 200ms), rejects immediately if a match is found in the buffer or arrives during the wait.
- **Queue inspection**: Non-destructive inspection of SQS queue state, available both programmatically and via HTTP.
  - **Programmatic**: `server.inspectQueue(name)` returns the queue's name, URL, ARN, attributes, and all messages grouped by state: `ready` (available for receive), `delayed` (waiting for delay to expire), `inflight` (received but not yet deleted, with receiptHandle and visibilityDeadline). Returns `undefined` for non-existent queues. Does not modify any state — messages remain where they are.
  - **HTTP `GET /_fauxqs/queues`**: Returns a JSON array of all queues with summary counts (`approximateMessageCount`, `approximateInflightCount`, `approximateDelayedCount`).
  - **HTTP `GET /_fauxqs/queues/:queueName`**: Returns full queue state (same shape as `inspectQueue()`). Returns 404 for non-existent queues.
  - **SqsQueue.inspectMessages()**: Internal method on `SqsQueue` that returns `{ ready, delayed, inflight }` snapshots. Handles both standard and FIFO queues (collects across all message groups for FIFO).

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
- Uses HTTP method + URL path + query params to determine action
- `GET /` → ListBuckets
- `PUT /:bucket` → CreateBucket, `HEAD /:bucket` → HeadBucket, `GET /:bucket` → ListObjects, `DELETE /:bucket` → DeleteBucket
- `PUT /:bucket/:key` → PutObject (or CopyObject when `x-amz-copy-source` header is present), `GET /:bucket/:key` → GetObject, `DELETE /:bucket/:key` → DeleteObject, `HEAD /:bucket/:key` → HeadObject
- `GET /:bucket?list-type=2` → ListObjectsV2 (supports `prefix`, `delimiter`, `max-keys`, `start-after`, `continuation-token`)
- `POST /:bucket?delete` → DeleteObjects (bulk delete via XML body)
- `POST /:bucket/:key?uploads` → CreateMultipartUpload, `PUT /:bucket/:key?partNumber=N&uploadId=ID` → UploadPart, `POST /:bucket/:key?uploadId=ID` → CompleteMultipartUpload, `DELETE /:bucket/:key?uploadId=ID` → AbortMultipartUpload
- XML responses for list/delete/multipart/error operations
- SDK must use `forcePathStyle: true` or a virtual-hosted-style helper (`createLocalhostHandler` / `interceptLocalhostDns`) for local emulators
- Presigned URLs work out of the box — `X-Amz-*` query params are ignored by the router. Use `@aws-sdk/s3-request-presigner`'s `getSignedUrl()` then `fetch()` the URL directly.

## Conventions

- Account ID: `000000000000`
- Region: `us-east-1`
- Queue URL format: `http://sqs.{region}.{host}:{port}/000000000000/{queueName}` (host defaults to `localhost`)
- Queue ARN format: `arn:aws:sqs:us-east-1:000000000000:{queueName}`
- Topic ARN format: `arn:aws:sns:us-east-1:000000000000:{topicName}`
- Auth: All credentials accepted, never validated

## Testing

Tests use `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`, and `@aws-sdk/client-s3` pointed at a Fastify test server (`startFauxqsTestServer()` in `test/helpers/setup.ts`). Each test file gets its own server instance on a random port.

Logger is disabled in tests (`buildApp({ logger: false })`) to keep output clean.

Coverage thresholds: 70% statements/functions/lines, 50% branches.

## Out of Scope

See `OUT_OF_SCOPE.md` for the full list. Key exclusions: non-SQS SNS delivery (HTTP, Lambda, SMS), persistence, auth validation.
