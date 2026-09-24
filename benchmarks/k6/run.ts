// Drives the k6 load tests against fauxqs once per (backend, scenario), each in a
// fresh fauxqs container on fresh storage, then reads the profiles back from
// Pyroscope and writes results/report.md.
//
//   node run.ts [--backends memory,sqlite,fs,postgresql] [--scenarios sqs-send,...]
//               [--duration 30s] [--vus 16] [--repeat 1] [--no-unprofiled] [--no-profiled]
//
// Needs Docker and Node 24 on the host, nothing else.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAMP = Date.now().toString(36);
// One directory per invocation, so an unprofiled pass and a profiled pass sit side by side.
const RESULTS = join(HERE, "results", STAMP);
const PROJECT = "fauxqs-k6";
const FAUXQS_PORT = process.env.FAUXQS_BENCH_PORT ?? "14566";

const ALL_BACKENDS = ["memory", "sqlite", "fs", "postgresql"] as const;
const ALL_SCENARIOS = ["sqs-send", "sqs-roundtrip", "sns-fanout", "s3-put-get"] as const;

interface Options {
  backends: string[];
  scenarios: string[];
  duration: string;
  vus: number;
  repeat: number;
  profiled: boolean;
  unprofiled: boolean;
}

interface Run {
  id: string;
  backend: string;
  scenario: string;
  profiled: boolean;
  repeat: number;
  startMs: number;
  endMs: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    backends: [...ALL_BACKENDS],
    scenarios: [...ALL_SCENARIOS],
    duration: "30s",
    vus: 16,
    repeat: 1,
    profiled: true,
    unprofiled: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--backends") opts.backends = next().split(",");
    else if (arg === "--scenarios") opts.scenarios = next().split(",");
    else if (arg === "--duration") opts.duration = next();
    else if (arg === "--vus") opts.vus = Number(next());
    else if (arg === "--repeat") opts.repeat = Number(next());
    else if (arg === "--no-profiled") opts.profiled = false;
    else if (arg === "--no-unprofiled") opts.unprofiled = false;
    else throw new Error(`Unknown option ${arg}`);
  }
  return opts;
}

function docker(args: string[], opts: { env?: Record<string, string>; quiet?: boolean } = {}): string {
  const res = spawnSync("docker", args, {
    cwd: HERE,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (${res.status}):\n${res.stderr}\n${res.stdout}`);
  }
  if (!opts.quiet && res.stderr.trim()) process.stderr.write(res.stderr);
  return res.stdout;
}

function compose(args: string[], env?: Record<string, string>, quiet = true): string {
  return docker(["compose", "-p", PROJECT, ...args], { env, quiet });
}

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function httpOk(url: string): Promise<boolean> {
  const res = await fetch(url);
  return res.ok;
}

function resetStorage(backend: string): void {
  compose(["rm", "-sfv", "fauxqs"]);
  spawnSync("docker", ["volume", "rm", "-f", `${PROJECT}_fauxqs-data`], { encoding: "utf8" });
  if (backend === "postgresql") {
    compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "fauxqs",
      "-d",
      "postgres",
      "-c",
      "DROP DATABASE IF EXISTS fauxqs WITH (FORCE)",
      "-c",
      "CREATE DATABASE fauxqs",
    ]);
  }
}

async function runOne(opts: Options, run: Omit<Run, "startMs" | "endMs">): Promise<Run> {
  resetStorage(run.backend);
  const env = {
    BENCH_BACKEND: run.backend,
    BENCH_SCENARIO: run.scenario,
    BENCH_RUN_ID: run.id,
    PYROSCOPE_ENABLED: String(run.profiled),
  };
  compose(["up", "-d", "--no-build", "fauxqs"], env);
  await waitFor("fauxqs", () => httpOk(`http://127.0.0.1:${FAUXQS_PORT}/health`), 60_000);

  const startMs = Date.now();
  compose(
    [
      "--profile",
      "tools",
      "run",
      "--rm",
      "--no-deps",
      "-e",
      `SUMMARY_FILE=/results/${STAMP}/${run.id}.json`,
      "-e",
      `DURATION=${opts.duration}`,
      "-e",
      `VUS=${opts.vus}`,
      "k6",
      "run",
      "--quiet",
      `/scenarios/${run.scenario}.js`,
    ],
    env,
  );
  const endMs = Date.now();

  // SIGTERM, so the profiled server flushes its last window before exiting.
  compose(["stop", "-t", "30", "fauxqs"], env);
  return { ...run, startMs, endMs };
}

interface K6Trend {
  avg: number;
  med: number;
  "p(95)": number;
  "p(99)": number;
  max: number;
}

interface K6Summary {
  metrics: Record<string, { values: Record<string, number> } & { values: Partial<K6Trend> }>;
}

function loadSummary(id: string): K6Summary | undefined {
  const file = join(RESULTS, `${id}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as K6Summary) : undefined;
}

interface ProfileReport {
  total: number;
  frames: Array<{ name: string; self: number; share: number }>;
}

function analyze(run: Run, type: "wall" | "cpu"): ProfileReport | undefined {
  const out = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      PROJECT,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "node",
      "fauxqs",
      "/profiler/node_modules/@lokalise/pyroscope-profiling/bin/analyze.mjs",
      "--url",
      "http://pyroscope:4040",
      "--service",
      "fauxqs",
      "--type",
      type,
      "--select",
      `run="${run.id}"`,
      "--from",
      String(run.startMs - 10_000),
      "--until",
      String(run.endMs + 60_000),
      "--top",
      "25",
      "--json",
    ],
    { cwd: HERE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (!out.stdout.trim()) return undefined;
  const report = JSON.parse(out.stdout) as ProfileReport;
  writeFileSync(join(RESULTS, `${run.id}.${type}.json`), JSON.stringify(report, null, 2));
  return report;
}

const SCENARIO_OPS: Record<string, string[]> = {
  "sqs-send": ["SendMessage"],
  "sqs-roundtrip": ["SendMessage", "ReceiveMessage", "DeleteMessage"],
  "sns-fanout": ["Publish"],
  "s3-put-get": ["PutObject", "GetObject"],
};

function fmtMs(v: number | undefined): string {
  return v === undefined ? "" : v < 10 ? v.toFixed(2) : v.toFixed(1);
}

function fmtNs(ns: number): string {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  return `${(ns / 1e6).toFixed(1)} ms`;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function writeReport(opts: Options, runs: Run[]): void {
  const lines: string[] = [
    "# fauxqs k6 results",
    "",
    `${opts.vus} VUs, closed loop, ${opts.duration} per run, ${opts.repeat} repeat(s). Generated ${new Date().toISOString()}.`,
    "",
  ];

  for (const profiled of [false, true]) {
    const subset = runs.filter((r) => r.profiled === profiled);
    if (subset.length === 0) continue;
    lines.push(`## Throughput and latency, profiler ${profiled ? "on" : "off"}`, "");
    lines.push(
      "Iterations per second is the median across repeats. Latencies are milliseconds, from the last repeat.",
      "",
    );
    for (const scenario of opts.scenarios) {
      const ops = SCENARIO_OPS[scenario] ?? [];
      lines.push(`### ${scenario}`, "");
      const header = ["backend", "iter/s", "failed", ...ops.flatMap((op) => [`${op} p50`, `${op} p95`, `${op} p99`])];
      lines.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
      for (const backend of opts.backends) {
        const reps = subset.filter((r) => r.scenario === scenario && r.backend === backend);
        const summaries = reps.map((r) => loadSummary(r.id)).filter((s): s is K6Summary => !!s);
        if (summaries.length === 0) continue;
        const last = summaries[summaries.length - 1];
        const rate = median(summaries.map((s) => s.metrics.iterations?.values.rate ?? 0));
        const failed = last.metrics.http_req_failed?.values.rate ?? 0;
        const cells = [
          backend,
          rate.toFixed(0),
          `${(failed * 100).toFixed(2)}%`,
          ...ops.flatMap((op) => {
            const v = last.metrics[`http_req_duration{op:${op}}`]?.values;
            return [fmtMs(v?.med), fmtMs(v?.["p(95)"]), fmtMs(v?.["p(99)"])];
          }),
        ];
        lines.push(`| ${cells.join(" | ")} |`);
      }
      lines.push("");
    }
  }

  const profiledRuns = runs.filter((r) => r.profiled);
  if (profiledRuns.length > 0) {
    lines.push("## Hotspots", "", "Self time per frame, top 12, from the last profiled repeat.", "");
    for (const scenario of opts.scenarios) {
      for (const backend of opts.backends) {
        const run = profiledRuns.filter((r) => r.scenario === scenario && r.backend === backend).at(-1);
        if (!run) continue;
        lines.push(`### ${scenario} / ${backend}`, "");
        for (const type of ["wall", "cpu"] as const) {
          const report = analyze(run, type);
          if (!report || report.total === 0) {
            lines.push(`${type}: no samples`, "");
            continue;
          }
          lines.push(`${type}, ${fmtNs(report.total)} total`, "", "| frame | self | share |", "|---|---|---|");
          for (const f of report.frames.slice(0, 12)) {
            lines.push(`| \`${f.name}\` | ${fmtNs(f.self)} | ${(f.share * 100).toFixed(1)}% |`);
          }
          lines.push("");
        }
      }
    }
  }

  writeFileSync(join(RESULTS, "report.md"), lines.join("\n"));
  writeFileSync(join(RESULTS, "runs.json"), JSON.stringify(runs, null, 2));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(RESULTS, { recursive: true });

  console.log("Building the profiled fauxqs image and starting Pyroscope and PostgreSQL...");
  compose(["build", "fauxqs"], undefined, false);
  compose(["up", "-d", "--wait", "pyroscope", "postgres"]);
  // A fresh Pyroscope drops what it is sent until /ready turns 200, about a minute in.
  await waitFor("pyroscope /ready", () => httpOk("http://127.0.0.1:4040/ready"), 180_000);

  const plan: Array<Omit<Run, "startMs" | "endMs">> = [];
  for (let repeat = 1; repeat <= opts.repeat; repeat++) {
    for (const scenario of opts.scenarios) {
      for (const backend of opts.backends) {
        for (const profiled of [false, true]) {
          if (profiled ? !opts.profiled : !opts.unprofiled) continue;
          const id = `${STAMP}-${scenario}-${backend}-${profiled ? "prof" : "noprof"}-${repeat}`;
          plan.push({ id, backend, scenario, profiled, repeat });
        }
      }
    }
  }

  const runs: Run[] = [];
  for (const [i, step] of plan.entries()) {
    console.log(`[${i + 1}/${plan.length}] ${step.scenario} on ${step.backend}, profiler ${step.profiled ? "on" : "off"}, repeat ${step.repeat}`);
    runs.push(await runOne(opts, step));
    writeFileSync(join(RESULTS, "runs.json"), JSON.stringify(runs, null, 2));
  }

  compose(["rm", "-sfv", "fauxqs"]);
  console.log("Reading profiles back from Pyroscope...");
  writeReport(opts, runs);
  console.log(`Done: ${join(RESULTS, "report.md")}`);
}

await main();
