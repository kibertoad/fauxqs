# fauxqs

Local SNS/SQS/S3 emulator for development and testing. Point your AWS SDK clients at fauxqs instead of real AWS.

State is in-memory by default: no external storage dependencies, single container, single port. Optional SQLite-based persistence is available by mounting a volume and setting `FAUXQS_PERSISTENCE=true`.

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
| `FAUXQS_PERSISTENCE` | Enable SQLite persistence (requires a volume mounted at `/data`) | `false` |
| `FAUXQS_DATA_DIR` | Directory for the SQLite database | `/data` (preset in image) |
| `FAUXQS_S3_STORAGE_DIR` | Store S3 objects as files on disk instead of SQLite blobs | (none) |
| `FAUXQS_DISABLE_CHECKSUM_VALIDATION` | Stop verifying uploaded S3 bodies against the `x-amz-checksum-*`/`Content-MD5` header the client sent | `false` |
| `FAUXQS_RUN_USER` | User the server runs as (name, uid, or `uid:gid`) | `node` (uid 1000) |
| `FAUXQS_RUN_AS_ROOT` | Keep the server running as root instead of dropping privileges | `false` |

## Container User

By default the server runs as the unprivileged `node` user (uid 1000). The entrypoint starts as root to bind dnsmasq to port 53 and to hand the mounted directories over to that user, so root-owned bind mounts like `-v ./volume:/data` keep working with nothing to prepare on the host. Directories `node` can already write to keep their ownership; the handover only happens where it is needed.

Two situations leave the server running as root, and both are visible in the log, so non-root is the default rather than a guarantee:

- `FAUXQS_RUN_AS_ROOT=true`, which selects root deliberately.
- A write directory that `chown` cannot hand over while root can still write to it. Some remote filesystems accept a `chown` without applying it; there the entrypoint logs `WARNING: Keeping the server as root, which can write to <dir>`. If neither the unprivileged user nor root can write to it, as on a read-only mount, the container names the directory and refuses to start instead of failing on its first write.

To avoid the root phase entirely, start the container as non-root. dnsmasq carries `cap_net_bind_service` as a file capability, so wildcard DNS still works:

```bash
docker run -p 4566:4566 --user 1000:1000 -v fauxqs-data:/data -e FAUXQS_PERSISTENCE=true kibertoad/fauxqs
```

In that mode a bind-mounted directory must already be writable by the uid you pass. The container cannot fix the ownership itself, so it names the directory and refuses to start.

Wildcard DNS needs the `NET_BIND_SERVICE` capability only where port 53 counts as privileged. Docker sets `net.ipv4.ip_unprivileged_port_start=0` by default, so it keeps working there even under `--cap-drop=ALL`. Most Kubernetes clusters leave port 53 privileged, so under the `restricted` policy add that one capability back to keep wildcard DNS. Without it on a privileged-port runtime, dnsmasq does not start; the container and the API are unaffected, and the log says wildcard DNS is unavailable.

The only clients that lose anything are the ones resolving `<bucket>.s3.<container-hostname>` through the container's own DNS, which means other containers on the same network. Clients on the host use the public `*.localhost.fauxqs.dev` wildcard, so they are unaffected. For a container client, give it an endpoint its own resolver can reach, such as the compose service name `http://fauxqs:4566`, and set `forcePathStyle: true`. Setting `forcePathStyle` on its own does not help, because it does not change the endpoint host.

## Persistence

State is in-memory by default. To persist queues, messages, topics, subscriptions, buckets, and objects across restarts, mount a volume at `/data` and set `FAUXQS_PERSISTENCE=true`:

```bash
docker run -p 4566:4566 -v fauxqs-data:/data -e FAUXQS_PERSISTENCE=true kibertoad/fauxqs
```

Without `FAUXQS_PERSISTENCE=true`, the server runs in-memory even if a volume is mounted. If no volume is mounted at `/data`, persistence is silently disabled regardless of the env var.

Alternatively, store S3 objects as plain files on disk with `FAUXQS_S3_STORAGE_DIR`:

```bash
docker run -p 4566:4566 -v ./local-s3:/s3data -e FAUXQS_S3_STORAGE_DIR=/s3data kibertoad/fauxqs
```

See [full documentation](https://github.com/kibertoad/fauxqs#persistence) for details.

## Multi-Tenant Management

Enable auto-cleanup and templated resource creation for shared environments:

```bash
docker run -p 4566:4566 \
  -v ./init.json:/app/init.json \
  -e FAUXQS_INIT=/app/init.json \
  -e FAUXQS_TENANT_TTL=300 \
  -e FAUXQS_TENANT_TEMPLATE=init \
  -e FAUXQS_TENANT_PERMANENT_PREFIXES=,staging- \
  kibertoad/fauxqs
```

Create isolated resource sets via REST:

```bash
curl -X POST http://localhost:4566/_fauxqs/tenants/feature-123-
```

See [full documentation](https://github.com/kibertoad/fauxqs#multi-tenant-management) for details.

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
