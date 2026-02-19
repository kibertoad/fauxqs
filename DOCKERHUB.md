# fauxqs

Local SNS/SQS/S3 emulator for development and testing. Point your AWS SDK clients at fauxqs instead of real AWS.

All state is in-memory. No persistence, no external storage dependencies. Single container, single port.

## Quick Start

```bash
docker run -p 4566:4566 kibertoad/fauxqs
```

Health check available at `GET http://localhost:4566/health`.

## With Init Config

Pre-create queues, topics, subscriptions, and buckets on startup:

```bash
docker run -p 4566:4566 \
  -v ./init.json:/app/init.json \
  -e FAUXQS_INIT=/app/init.json \
  kibertoad/fauxqs
```

```json
{
  "queues": [{ "name": "my-queue" }, { "name": "my-dlq" }],
  "topics": [{ "name": "my-events" }],
  "subscriptions": [{ "topic": "my-events", "queue": "my-queue" }],
  "buckets": ["my-uploads"]
}
```

## Docker Compose

```yaml
services:
  fauxqs:
    image: kibertoad/fauxqs:latest
    ports:
      - "4566:4566"
    environment:
      - FAUXQS_INIT=/app/init.json
    volumes:
      - ./init.json:/app/init.json

  app:
    # ...
    depends_on:
      fauxqs:
        condition: service_healthy
```

The image has a built-in `HEALTHCHECK`, so `service_healthy` works without extra configuration.

## Connecting SDK Clients

```typescript
import { SQSClient } from "@aws-sdk/client-sqs";
import { SNSClient } from "@aws-sdk/client-sns";
import { S3Client } from "@aws-sdk/client-s3";

const sqs = new SQSClient({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const sns = new SNSClient({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

// S3 with virtual-hosted-style via fauxqs.dev wildcard DNS — no helpers needed
const s3 = new S3Client({
  endpoint: "http://s3.localhost.fauxqs.dev:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
```

Any credentials are accepted and never validated.

## S3 Virtual-Hosted-Style

The `fauxqs.dev` domain provides wildcard DNS — `*.localhost.fauxqs.dev` resolves to `127.0.0.1`. Virtual-hosted-style S3 requests work out of the box with no configuration.

Alternatively, use `forcePathStyle: true` on the S3 client if you prefer path-style URLs.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FAUXQS_PORT` | Port to listen on | `4566` |
| `FAUXQS_HOST` | Host for queue URLs | `localhost` |
| `FAUXQS_DEFAULT_REGION` | Fallback region for ARNs and URLs | `us-east-1` |
| `FAUXQS_LOGGER` | Enable request logging | `true` |
| `FAUXQS_INIT` | Path to JSON init config file | (none) |

## Supported Services

**SQS** — CreateQueue, DeleteQueue, SendMessage, ReceiveMessage, DeleteMessage, batch operations, long polling, visibility timeout, delay queues, dead letter queues, FIFO queues, message attributes, tags

**SNS** — CreateTopic, DeleteTopic, Subscribe, Publish, PublishBatch, filter policies (MessageAttributes and MessageBody scope), raw message delivery, SNS-to-SQS fan-out, FIFO topics, tags

**S3** — CreateBucket, PutObject, GetObject, DeleteObject, HeadObject, CopyObject, ListObjects/V2, DeleteObjects, multipart uploads, presigned URLs, user metadata, virtual-hosted-style and path-style

**STS** — GetCallerIdentity (mock identity for CLI/Terraform compatibility)

## Platforms

`linux/amd64`, `linux/arm64`

## Links

- [GitHub](https://github.com/kibertoad/fauxqs)
- [npm](https://www.npmjs.com/package/fauxqs)
- [Full documentation](https://github.com/kibertoad/fauxqs#readme)
