# Benchmarking

SQS throughput benchmarks comparing fauxqs deployment modes against LocalStack.

## Setups

| Name | How it runs | What it measures |
|------|-------------|------------------|
| **fauxqs-library** | Imported as a Node.js library via `startFauxqs()` — server runs in the same process as the benchmark client | Raw in-process performance with no network or container overhead |
| **fauxqs-docker-official** | Pre-built Docker image (`kibertoad/fauxqs:latest`) with dnsmasq DNS server for S3 virtual-hosted-style routing | Production Docker deployment, includes DNS routing overhead |
| **fauxqs-docker-lite** | Generic `node:24-alpine` container running `npx fauxqs` — no dnsmasq, no DNS routing | Lightweight containerized deployment without the DNS layer |
| **localstack** | LocalStack Docker image (`localstack/localstack`) with `SERVICES=sqs` | Baseline comparison against the most popular local AWS emulator |

### Key differences between Docker setups

The **official** Docker image bundles [dnsmasq](https://thekelleys.org.uk/dnsmasq/doc.html), a lightweight DNS server that resolves the container hostname and all its subdomains to the container IP. This enables S3 virtual-hosted-style access from other containers without `forcePathStyle`. The trade-off is a slightly larger image and the overhead of the DNS process.

The **lite** setup is a plain Node.js Alpine container that installs fauxqs on the fly via `npx`. It has no DNS routing — S3 virtual-hosted-style requires `forcePathStyle` or external DNS configuration. It's useful for measuring fauxqs performance in a container without the dnsmasq layer.

## Methodology

Each benchmark creates a single standard SQS queue and runs two tasks using [tinybench](https://github.com/tinylibs/tinybench):

1. **Publish 5,000 messages** — sends 5,000 individual `SendMessage` calls sequentially, then purges the queue.
2. **Consume 5,000 messages** — pre-publishes 5,000 messages as unmeasured setup, then receives and deletes them one at a time via `ReceiveMessage` (MaxNumberOfMessages=1) + `DeleteMessage`. Only the receive+delete cycle is measured.

No batching is used — every publish and consume is a single-message SDK call, measuring per-message throughput.

Each task runs **1 warmup iteration** (results discarded) followed by **5 measured iterations**. Tinybench reports the mean, p75, p99, and standard deviation across the 5 measured iterations.

The queue is purged between iterations. The benchmark client uses `@aws-sdk/client-sqs` pointed at the target endpoint.

**Total time** includes container startup, health check polling, warmup, all measured iterations, setup/teardown, and container shutdown — representing the full wall-clock cost of running the benchmark end to end.

## Latest Results

Run on 2026-02-21.

| Component | Version                 |
|-----------|-------------------------|
| fauxqs | 1.6.8                   |
| Node.js | v24.13.0                |
| Platform | Windows 11 (win32)      |
| `kibertoad/fauxqs` | `latest` (build 1.6.8)       |
| `node` | `24-alpine`             |
| `localstack/localstack` | `latest` (build 4.13.2) |

### Publish 5,000 Messages

| Setup | Mean | p75 | p99 | Std Dev |
|-------|------|-----|-----|---------|
| fauxqs-library | 3.55s | 3.56s | 3.59s | 38.5ms |
| fauxqs-docker-official | 5.79s | 5.81s | 5.90s | 66.9ms |
| fauxqs-docker-lite | 5.83s | 5.87s | 5.91s | 62.2ms |
| localstack | 10.25s | 10.27s | 10.35s | 63.0ms |

### Consume 5,000 Messages

| Setup | Mean | p75 | p99 | Std Dev |
|-------|------|-----|-----|---------|
| fauxqs-library | 7.66s | 7.69s | 7.74s | 59.9ms |
| fauxqs-docker-official | 12.18s | 12.21s | 12.21s | 25.4ms |
| fauxqs-docker-lite | 12.21s | 12.22s | 12.24s | 19.5ms |
| localstack | 21.30s | 21.32s | 21.47s | 108.3ms |

### Total Wall-Clock Time

| Setup | Total |
|-------|-------|
| fauxqs-library | 90.69s |
| fauxqs-docker-official | 145.49s |
| fauxqs-docker-lite | 158.24s |
| localstack | 256.32s |

## Running benchmarks

From the `benchmarks/` directory:

```bash
npm install
```

### Individual benchmarks

```bash
npm run bench:fauxqs-library
npm run bench:fauxqs-docker-official
npm run bench:fauxqs-docker-lite
npm run bench:localstack
```

The Docker-based benchmarks (`fauxqs-docker-official`, `fauxqs-docker-lite`, `localstack`) require Docker to be running. They use `docker compose` to start and stop containers automatically.

### All benchmarks + summary

```bash
npm run bench:all
```

Runs all four benchmarks sequentially, then merges results into `results/RESULTS.md` and `results/_summary.json`.

### Other commands

```bash
npm run bench:merge    # Re-generate summary from existing result files
npm run bench:clean    # Delete all result files
```

## Output

Each benchmark writes a JSON file to `results/` (e.g., `results/fauxqs-library.json`). The merge step combines all results into:

- `results/RESULTS.md` — markdown table with ops/sec, mean, p75, p99, and total time
- `results/_summary.json` — combined JSON for programmatic use
