# k6 load tests with Pyroscope profiles

HTTP load tests for fauxqs's persistence backends, with a CPU and wall-clock
profile of every run. `run.ts` answers two questions per backend and scenario:
how fast it is under a fixed concurrency, and which frames the time went to.

The findings from the last full run are in [RESULTS.md](RESULTS.md).

## What runs

Everything is a container on one compose network, so no request crosses the
host boundary and the Windows host needs nothing but Docker and Node 24:

| service | image | role |
|---|---|---|
| `fauxqs` | built from this checkout by [`Dockerfile`](Dockerfile) | fauxqs `dist/`, started by [`profiler/server.ts`](profiler/server.ts) with [`@lokalise/pyroscope-profiling`](https://github.com/lokalise/shared-ts-libs/tree/main/packages/app/pyroscope-profiling) attached |
| `postgres` | `postgres:17-alpine` | the `postgresql` backend, stock configuration |
| `pyroscope` | `grafana/pyroscope:2.3.1` | receives the profiles |
| `k6` | `grafana/k6:1.0.0` | the load generator |

The profiler has to run on Linux: `@datadog/pprof` compiles labelled wall
profiling out on Windows, which is why fauxqs runs in a container here rather
than as a host process.

### Backends

| `BENCH_BACKEND` | SQS and SNS state | S3 objects |
|---|---|---|
| `memory` | in memory | in memory |
| `sqlite` | SQLite (`dataDir`) | SQLite blobs |
| `fs` | SQLite (`dataDir`) | files (`s3StorageDir`) |
| `postgresql` | PostgreSQL | PostgreSQL `bytea` |

`sqlite` and `fs` differ only in where S3 bodies go. The `fauxqs` data
directory and the PostgreSQL data directory are both Docker volumes, so the two
sides use the same storage.

### Scenarios

Each is a closed loop: `VUS` virtual users (default 16), each sending its next
request as soon as the last one returns, for `DURATION` (default 30s).

| scenario | per iteration | backend writes per iteration |
|---|---|---|
| `sqs-send` | `SendMessage`, 1 KiB | 1 insert |
| `sqs-roundtrip` | `SendMessage`, `ReceiveMessage`, `DeleteMessage` | insert, in-flight update, delete |
| `sns-fanout` | `Publish` to a topic with 3 raw SQS subscriptions | 3 inserts |
| `s3-put-get` | `PutObject` of 64 KiB, then `GetObject` of the same key | 1 upsert, 1 body read |

The scripts talk raw HTTP (SQS JSON protocol, SNS query protocol, S3
path-style) without SigV4, which fauxqs does not verify, so the load
generator's own cost stays out of the numbers.

## Running it

```bash
cd benchmarks/k6
node run.ts                                    # the full matrix, profiler on and off
node run.ts --no-profiled --repeat 3           # headline numbers only
node run.ts --backends fs,postgresql --scenarios s3-put-get --duration 60s
```

Each invocation writes `results/<id>/report.md` (tables and hotspots), the raw
k6 summaries, and the profile reports as JSON. Every run starts a fresh fauxqs
container on an empty data volume and, for `postgresql`, a recreated database.

The first invocation waits about a minute for Pyroscope's `/ready`: a fresh
Pyroscope drops whatever it receives until then.

A profiled run is slower than an unprofiled one. Read latencies and throughput
from the unprofiled runs, and use the profiled ones for where the time went.

### Reading a profile by hand

Profiles carry `backend`, `scenario` and `run` labels. `pyroscope-analyze` is in
the fauxqs image, so it needs nothing on the host:

```bash
docker compose -p fauxqs-k6 run --rm --no-deps --entrypoint node fauxqs \
  /profiler/node_modules/@lokalise/pyroscope-profiling/bin/analyze.mjs \
  --url http://pyroscope:4040 --service fauxqs --type cpu --from now-1h \
  --select 'backend="postgresql",scenario="s3-put-get"' --tree
```

`--type wall` against `--type cpu` separates waiting from working. A large
`:(idle):0` frame in the CPU profile of a saturated run means the process is
waiting on something, and that making its code faster will not raise the
throughput. The Pyroscope UI is on <http://localhost:4040>.

`docker compose -p fauxqs-k6 down -v` removes the stack and every stored profile.
