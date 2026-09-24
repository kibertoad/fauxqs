// fauxqs with the Pyroscope profiler attached, for load tests only. One process
// serves one (backend, scenario) run, and both are profile labels, so a flame
// graph can be selected per run without relying on time windows.
import {
  resolveProfilingConfigFromEnv,
  resolveProfilingContextFromEnv,
  startProfiling,
  stopProfiling,
  type ProfilingLogger,
} from "@lokalise/pyroscope-profiling";
import { startFauxqs } from "/app/dist/app.js";

type Backend = "memory" | "sqlite" | "fs" | "postgresql";

const backend = (process.env.BENCH_BACKEND ?? "memory") as Backend;
const scenario = process.env.BENCH_SCENARIO ?? "unknown";
const runId = process.env.BENCH_RUN_ID ?? "manual";

const write =
  (level: string) =>
  (objOrMsg: unknown, msg?: unknown): void => {
    const text = typeof objOrMsg === "string" ? objOrMsg : `${msg ?? ""} ${JSON.stringify(objOrMsg)}`;
    console.error(`[${level}] ${text}`);
  };
const logger: ProfilingLogger = {
  trace: () => {},
  debug: () => {},
  info: write("info"),
  warn: write("warn"),
  error: write("error"),
  fatal: write("fatal"),
};

function persistenceOptions(): Parameters<typeof startFauxqs>[0] {
  switch (backend) {
    case "memory":
      return {};
    case "sqlite":
      // SQS, SNS and S3 bodies all in one SQLite file.
      return { dataDir: "/data" };
    case "fs":
      // SQS and SNS in SQLite, S3 objects as plain files.
      return { dataDir: "/data", s3StorageDir: "/data/s3" };
    case "postgresql": {
      const postgresqlUrl = process.env.FAUXQS_POSTGRESQL_URL;
      if (!postgresqlUrl) throw new Error("FAUXQS_POSTGRESQL_URL is required for the postgresql backend");
      return { persistenceBackend: "postgresql", postgresqlUrl };
    }
    default:
      throw new Error(`Unknown BENCH_BACKEND "${backend}"`);
  }
}

await startProfiling(
  resolveProfilingConfigFromEnv({ appName: "fauxqs" }),
  { ...resolveProfilingContextFromEnv(), tags: { backend, scenario, run: runId } },
  logger,
);

const server = await startFauxqs({ port: 4566, logger: false, host: "localhost", ...persistenceOptions() });
logger.info(`fauxqs listening on ${server.port} (backend=${backend}, scenario=${scenario})`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop();
  // Flushes the last wall-profile window; without it a short run loses its tail.
  await stopProfiling(logger);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
