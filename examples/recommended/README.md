# Recommended Testing Setup

A complete example demonstrating the recommended dual-mode testing setup with fauxqs.

## The app

`src/app.ts` is a simple Fastify service with two endpoints:

- **`POST /files/:key`** — uploads content to S3, sends a direct SQS notification, and publishes an SNS event (fans out to subscribed queues with filter policies)
- **`GET /files/:key`** — downloads content from S3

The app accepts an `AppConfig` with the AWS endpoint, bucket name, queue URL, and topic ARN. This makes it easy to point at either a library-mode fauxqs instance or a Docker container.

## Library mode (unit/integration tests)

Tests in `test/` use fauxqs as an in-process library. Each test suite gets its own server instance on a random port — no Docker, no port conflicts, no shared state.

```bash
npm install
npm test
```

### Programmatic API features demonstrated

**Resource creation:**
- `setup()` — bulk creation of queues, topics, subscriptions, and buckets in dependency order
- `createQueue()` — with attributes (VisibilityTimeout, RedrivePolicy for DLQ)
- `createBucket()`, `createTopic()`, `subscribe()` — individual resource creation
- Idempotent — re-applying setup skips existing resources

**Message spy (`server.spy`):**
- `waitForMessage()` with partial-object filter — `{ service: "s3", bucket: "app-files", status: "uploaded" }`
- `waitForMessage()` with predicate function — `(msg) => msg.service === "sqs" && msg.body.includes("report")`
- `waitForMessage()` with status shorthand — second parameter filters by event status
- `waitForMessageWithId()` — track a specific message by its SQS/SNS message ID
- `waitForMessages()` — collect N matching events before resolving
- `expectNoMessage()` — negative assertion (e.g., verify filter policy dropped a message)
- `checkForMessage()` — synchronous, non-blocking buffer lookup
- `getAllMessages()` — full buffer access with discriminated union narrowing
- `clear()` — reset spy buffer between tests
- Timeout on all async methods — prevents tests from hanging

**Queue inspection (`server.inspectQueue()`):**
- Non-destructive — see all messages without consuming them
- Messages grouped by state: `ready`, `delayed`, `inflight`
- Inflight entries include `receiptHandle` and `visibilityDeadline`
- Returns `undefined` for non-existent queues

**State management:**
- `purgeAll()` — clears all messages, topics, subscriptions, and spy buffer

**DLQ tracking:**
- Spy captures `"dlq"` events when messages exceed `maxReceiveCount`
- Combined with `inspectQueue()` to verify DLQ message arrival

## Docker mode (local dev / acceptance tests)

`docker-compose.yml` runs fauxqs as a standalone container with `fauxqs-init.json` pre-creating the same resources that `setup()` creates in library mode.

```bash
docker compose up
```

Point your app at `http://localhost:4566`. The init config creates all queues (including DLQ with RedrivePolicy), topics, subscriptions (with filter policies), and buckets before the healthcheck passes.

## When to use which

| Concern | Library mode | Docker mode |
|---------|-------------|-------------|
| Startup time | Milliseconds | Seconds |
| CI dependency | None (npm only) | Docker |
| Spy / inspectQueue | Full programmatic API | HTTP inspection endpoints only |
| Network realism | In-process (Fastify inject) | Real TCP connections |
| Multi-service | Single process | docker-compose |
| State reset | `purgeAll()` / `spy.clear()` | Restart container |
| Filter policy testing | `expectNoMessage()` assertions | Manual verification |
| DLQ testing | Spy `"dlq"` events + `inspectQueue()` | Receive from DLQ via SDK |
