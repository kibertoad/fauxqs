# Persistence backends under load: results

Measured with the harness in this directory (see [README.md](README.md)) on Docker Desktop
(WSL2, 24 CPUs, 31 GiB), PostgreSQL 17 with its stock configuration, 16 closed-loop VUs.
Throughput and latency come from unprofiled runs, 20s each, median of 3 repeats. Hotspots
come from one 30s profiled run per cell. Higher iter/s is better, lower latency is better.

The FS-based backends are `sqlite` (everything in one SQLite file) and `fs` (SQS and SNS in
SQLite, S3 objects as files). `memory` is the ceiling fauxqs itself sets.

## Summary

- For SQS and SNS, PostgreSQL is 5 to 8 times faster than both FS-based backends, and has a
  far tighter tail. The FS-based backends are limited to about 500 writes per second in
  total, whatever the concurrency.
- That limit is one `fsync` per SQLite commit, run synchronously on the event loop. It is a
  default rather than a property of SQLite: with `PRAGMA synchronous = NORMAL` the same
  backends run 19 to 29 times faster on SQS and SNS, and overtake PostgreSQL by 2.3 to 3.4
  times.
- PostgreSQL is limited to about 4,000 writes per second by `pg.Pool`'s default of 10
  connections. A pool of 32 raises throughput by 37% to 62%.
- For S3, `fs` is the fastest persistent backend, but it never `fsync`s, so it is not
  comparing like with like. PostgreSQL spends most of its S3 CPU on hex-encoding `bytea`;
  reading bodies in binary format raises its throughput by 35%.
- On every backend, S3 spends the largest share of its CPU hashing bodies (MD5 for the ETag).

## Throughput and latency

Latencies are milliseconds per request.

### SQS: `SendMessage` only (1 write per iteration)

| backend | iter/s | p50 | p95 | p99 |
|---|---|---|---|---|
| memory | 22,007 | 0.52 | 1.46 | 2.81 |
| sqlite | 489 | 27.9 | 52.2 | 71.0 |
| fs | 450 | 29.7 | 63.3 | 121.4 |
| postgresql | 3,996 | 3.73 | 5.42 | 7.38 |

### SQS: send, receive, delete (3 writes per iteration)

| backend | iter/s | Send p50 / p99 | Receive p50 / p99 | Delete p50 / p99 |
|---|---|---|---|---|
| memory | 7,229 | 0.57 / 2.58 | 0.57 / 2.62 | 0.55 / 2.56 |
| sqlite | 166 | 27.3 / 71.2 | 27.3 / 64.1 | 27.2 / 64.7 |
| fs | 169 | 27.7 / 69.7 | 27.7 / 67.0 | 27.6 / 65.1 |
| postgresql | 1,336 | 3.70 / 6.84 | 3.66 / 6.76 | 3.68 / 6.67 |

### SNS: `Publish` fanned out to 3 SQS queues (3 writes per iteration)

| backend | iter/s | p50 | p95 | p99 |
|---|---|---|---|---|
| memory | 19,793 | 0.52 | 1.50 | 3.75 |
| sqlite | 159 | 87.6 | 180.1 | 262.7 |
| fs | 149 | 96.2 | 174.5 | 236.1 |
| postgresql | 1,299 | 12.2 | 16.4 | 19.9 |

### S3: 64 KiB `PutObject` then `GetObject`

| backend | iter/s | Put p50 / p99 | Get p50 / p99 |
|---|---|---|---|
| memory | 3,508 | 1.86 / 7.37 | 1.77 / 7.17 |
| sqlite | 324 | 24.4 / 62.8 | 20.9 / 57.6 |
| fs | 2,031 | 3.36 / 10.6 | 3.19 / 10.3 |
| postgresql | 959 | 9.08 / 17.8 | 6.25 / 14.9 |

In writes per second, `sqlite` and `fs` sit between 450 and 510 in every SQS and SNS
scenario, and PostgreSQL between 3,900 and 4,000. Neither number depends on what the
request does, which is what a fixed per-write cost behind a fixed amount of concurrency looks
like.

## Hotspots and bottlenecks

### 1. SQLite: one fsync per commit, on the event loop

In every SQS and SNS profile of `sqlite` and `fs`, 93% to 95% of wall time is one frame,
`:run:0`, which is `node:sqlite`'s `StatementSync.run`. The CPU profile of the same 30s run
holds only 3.6 s of samples, so the process is not computing inside that frame. It is blocked.

`node:sqlite` opens databases with `synchronous = FULL` (reported as `2`), and fauxqs sets only
`journal_mode = WAL`. In WAL mode, FULL syncs the WAL on every commit. Measured directly in the
same container on the same kind of Docker volume, one insert takes 2.5 ms with FULL and
0.005 ms with NORMAL.

`node:sqlite` is synchronous, so that 2.5 ms blocks the only thread. Writes run strictly one
at a time, which caps the backend at about 1 / 2.5 ms, or 400 to 500 writes per second.
Concurrency makes no difference, and every other request waits in line: 16 VUs sharing one
2 ms slot is the 27 ms median in the tables. SNS fan-out pays it three times per publish,
which is why its p50 is 88 ms.

With `PRAGMA synchronous = NORMAL` added after the WAL pragma, and nothing else changed:

| scenario | sqlite before | sqlite after | fs before | fs after | postgresql |
|---|---|---|---|---|---|
| sqs-send | 489 | 9,141 | 450 | 8,891 | 3,996 |
| sqs-roundtrip | 166 | 3,318 | 169 | 3,898 | 1,336 |
| sns-fanout | 159 | 4,442 | 149 | 4,303 | 1,299 |
| s3-put-get | 324 | 1,203 | 2,031 | 2,052 | 959 |

`sqs-send` p99 goes from 71 ms to 17 ms. WAL with NORMAL cannot corrupt the database. What it
gives up is durability of the last commits before a power loss or OS crash, but not before a
process crash. For a local emulator that is the right trade. It is also the setting the SQLite
documentation recommends for WAL.

### 2. PostgreSQL: the connection pool, then round trips

Under full load, about half of the PostgreSQL CPU samples are `:(idle):0` (48% to 51% across
the SQS and SNS scenarios). fauxqs is not the bottleneck here. It is waiting.

What it waits for is a connection. Every write-through is its own autocommit statement, and
`pg.Pool` defaults to 10 connections. At about 2.5 ms per statement, that is 4,000 statements
per second, which is the ceiling every scenario hits. Raising the pool to 32 connections,
with nothing else changed:

| scenario | pool 10 | pool 32 | p50 before / after |
|---|---|---|---|
| sqs-send | 4,193 | 5,749 | 3.46 / 2.43 ms |
| sqs-roundtrip | 1,321 | 1,976 | 3.97 / 2.35 ms |
| sns-fanout | 1,312 | 2,108 | 11.1 / 6.97 ms |

The remaining cost is the round trip itself, and it multiplies whenever one request awaits
several writes in sequence. A publish to three subscribers makes three sequential inserts, so
its latency is three times a send's. The same applies to `SendMessageBatch` and to a
`ReceiveMessage` that returns several messages, which updates each one in turn. Batching those
into one multi-row statement or one transaction per request would turn N round trips into one.

`:writev:0` is 13% to 20% of PostgreSQL wall time. It is the socket write of each query to the
server, one syscall per statement, and batching would shrink it too.

### 3. PostgreSQL S3 bodies: hex `bytea`

In the `s3-put-get` profile of `postgresql`, the top frames are `Buffer.toString`,
`_copyActual`, `createUnsafeBuffer` and `hexWrite`. Together they account for about 32% of
wall time. node-postgres receives `bytea` in text format, which is hex. A 64 KiB body arrives
as a 128 KiB string, is decoded back into a buffer, and `readBody` then copies that buffer
once more with `Buffer.from`.

Reading the body with `binary: true` on the query, and returning the buffer without the copy,
takes the backend from 959 to 1,295 iter/s. The `GetObject` p50 drops from 6.25 to 4.19 ms.

### 4. S3 on every backend: hashing the body

`:update:0` is `Hash.update`, from the MD5 that `S3Store` computes over every body to make the
ETag. It is 42% of wall time in the `memory` S3 profile and 19% in `fs`. It is the largest
single cost of `PutObject` wherever storage is not the bottleneck. Real S3 computes the same
hash, so it is not removable, but it is the frame to watch if S3 throughput matters.

### 5. `fs` S3 is fast because it does not sync

`fs` is the fastest persistent S3 backend, and its profile is spread across synchronous file
syscalls: `open`, `read`, `close`, `writeBuffer` and `writeFileUtf8`, each 4% to 9% of wall
time. `FileS3Persistence` writes with `writeFileSync` and never calls `fsync`, so an object
lives in the page cache until the kernel flushes it. PostgreSQL and SQLite with FULL both wait
for the disk. The comparison is therefore between a durable write and a buffered one.
Because the file calls are synchronous, they also block the event loop, though each one is
short.

### 6. What remains without persistence

With `memory`, persistence is out of the picture, and the profile is fauxqs's own request
path: `writeUtf8String` (writing HTTP responses, 20% to 28%), `RandomBytesJob` and
`randomBytes` (256 random bytes per receipt handle, plus message ids), Fastify's `serialize`,
and `getQueue` / `parseQueueUrl`, which parse the queue URL on every call. None of these is
large enough on its own to be worth optimising before the persistence costs above.

## Caveats

- Everything runs on one Docker Desktop VM. The fsync cost is that VM's virtual disk. On
  bare-metal NVMe, FULL costs less, but the one-at-a-time structure stays.
- PostgreSQL runs with its stock configuration (`synchronous_commit = on`), so each of its
  commits is durable, like SQLite with FULL. It benefits from group commit across its
  connections, which a single synchronous SQLite handle cannot use.
- The headline tables were measured on the merge of main into the PostgreSQL branch
  (`c07fdad`). The experiments ran on `2db6c2c`, which adds the review fixes. None of those
  fixes touch the standard-queue or S3 paths these scenarios exercise.
- Profiled and unprofiled runs of the same cell landed within run-to-run variance of each
  other (up to about 20% either way), so the profiler's overhead did not show at this load.
  The tables use the unprofiled runs regardless.
