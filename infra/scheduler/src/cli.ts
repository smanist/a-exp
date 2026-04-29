#!/usr/bin/env node
/** CLI for the trimmed OpenAkari scheduler. */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const schedulerStateDir = resolve(repoRoot, ".scheduler");
const systemEnvKeys = new Set(Object.keys(process.env));

function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!systemEnvKeys.has(key)) process.env[key] = val;
    }
  } catch {
    // Optional.
  }
}

export function mergeEnvContent(target: Record<string, string>, content: string): void {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    target[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}

loadEnvFile(resolve(repoRoot, "infra/.env"));
loadEnvFile(resolve(repoRoot, "infra/scheduler/.env"));

import { JobStore } from "./store.js";
import { SchedulerService } from "./service.js";
import { executeJob } from "./executor.js";
import { getPendingApprovals } from "./notify.js";
import * as slack from "./slack.js";
import { listSessions } from "./session.js";
import { listExperiments } from "./experiments.js";
import { getUnifiedStatus, formatUnifiedStatus, toStatusExperiment, type StatusJob } from "./status.js";
import { startApiServer, stopApiServer } from "./api/server.js";
import {
  checkForExistingInstance,
  acquireLock,
  releaseLock,
  getSchedulerLockfilePath,
  isPidAlive,
} from "./instance-guard.js";
import type { Job, JobCreate, Schedule } from "./types.js";

const HELP = `
akari — Cron scheduler for OpenAkari Core

Commands:
  start                     Run the scheduler daemon
  stop                      Stop the running scheduler daemon
  add <options>             Add a scheduled job
  list                      List jobs
  remove <id>               Remove a job
  run <id>                  Run a job now
  enable <id>               Enable a job
  disable <id>              Disable a job
  status                    Show sessions, experiments, and jobs
  heartbeat                 Notify Slack if APPROVAL_QUEUE.md has pending items
  check-health              Ping the scheduler API and optionally notify Slack

Add options:
  --name <name>             Job name
  --cron <expr>             Cron expression, e.g. "0 * * * *"
  --every <ms>              Interval in milliseconds
  --tz <timezone>           IANA timezone for cron jobs
  --message <msg>           Prompt message
  --message-default         Use the default work-cycle prompt
  --message-project <name>  Use the project-scoped work-cycle prompt
  --model <model>           Model name
  --cwd <dir>               Working directory

Run options:
  --message <msg>           Override prompt for this run
  --model <model>           Override model for this run
  --cwd <dir>               Override working directory for this run
  --max-duration-ms <ms>    Override max session duration

Check-health options:
  --url <url>               Scheduler API URL (default: http://localhost:8420)
  --timeout <ms>            Request timeout ms (default: 5000)
  --notify                  Send Slack DM on failure
`.trim();

function fail(msg: string): never {
  console.error(msg);
  return process.exit(1) as never;
}

function requireArg(val: string | undefined, label: string): string {
  if (!val) return fail(`Error: ${label} required.`);
  return val;
}

function parseOptions(args: string[]): Record<string, string | true> {
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

function defaultWorkCyclePrompt(): string {
  return [
    "Run one OpenAkari work cycle.",
    "Read AGENTS.md, inspect project README/TASKS files, select one actionable task, execute it, update project memory, verify, and commit the completed logical unit.",
  ].join("\n");
}

function projectWorkCyclePrompt(project: string): string {
  return [
    `Run one OpenAkari work cycle scoped to projects/${project}.`,
    "Read the project README and TASKS, select one actionable task, execute it, update project memory, verify, and commit the completed logical unit.",
  ].join("\n");
}

function formatSchedule(schedule: Schedule): string {
  if (schedule.kind === "cron") return schedule.tz ? `${schedule.expr} (${schedule.tz})` : schedule.expr;
  return `every ${schedule.everyMs}ms`;
}

function toStatusJob(job: Job): StatusJob {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    schedule: formatSchedule(job.schedule),
    nextRunAtMs: job.state.nextRunAtMs,
    lastStatus: job.state.lastStatus,
    lastRunAtMs: job.state.lastRunAtMs,
    runCount: job.state.runCount,
  };
}

async function buildStatus(daemonState: "running" | "stopped") {
  const store = new JobStore();
  await store.load();
  const experiments = await listExperiments(repoRoot);
  return getUnifiedStatus({
    sessions: listSessions(),
    experiments: experiments.map((e) => toStatusExperiment(e)),
    jobs: store.list().map(toStatusJob),
    daemonState,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  if (cmd === "start") return cmdStart();
  if (cmd === "stop") return cmdStop();
  if (cmd === "add") return cmdAdd(args.slice(1));
  if (cmd === "list") return cmdList();
  if (cmd === "remove") return cmdRemove(requireArg(args[1], "job ID"));
  if (cmd === "run") return cmdRun(requireArg(args[1], "job ID"), args.slice(2));
  if (cmd === "enable") return cmdSetEnabled(requireArg(args[1], "job ID"), true);
  if (cmd === "disable") return cmdSetEnabled(requireArg(args[1], "job ID"), false);
  if (cmd === "status") return cmdStatus();
  if (cmd === "heartbeat") return cmdHeartbeat();
  if (cmd === "check-health") return cmdCheckHealth(args.slice(1));
  return fail(`Unknown command: ${cmd}\n\n${HELP}`);
}

async function cmdStart(): Promise<void> {
  const lockfile = getSchedulerLockfilePath(schedulerStateDir);
  const check = checkForExistingInstance(lockfile);
  if (!check.canStart) fail(check.message);
  acquireLock(lockfile);

  const service = new SchedulerService({
    onAfterRun: async (_job, _result) => {
      // Notifications are sent by executeJob; this hook is reserved for future
      // retained core metrics.
    },
  });

  const shutdown = async () => {
    service.stop();
    await stopApiServer().catch(() => {});
    releaseLock(lockfile);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await slack.startSlackBot({ repoDir: repoRoot }).catch((err) => {
    console.error(`[slack] Failed to start: ${err}`);
  });
  const apiPort = await startApiServer({
    getStatus: () => buildStatus("running"),
  });
  console.log(`[api] Listening on http://127.0.0.1:${apiPort}`);
  await service.start();
}

export async function stopScheduler(): Promise<{ ok: boolean; message: string; pid?: number }> {
  const lockfile = getSchedulerLockfilePath(schedulerStateDir);
  if (!existsSync(lockfile)) return { ok: true, message: "Scheduler is not running" };
  const pid = Number(readFileSync(lockfile, "utf-8").trim());
  if (!Number.isFinite(pid) || !isPidAlive(pid)) {
    releaseLock(lockfile);
    return { ok: true, message: "Removed stale scheduler lockfile" };
  }
  process.kill(pid, "SIGTERM");
  return { ok: true, message: `Sent SIGTERM to scheduler PID ${pid}`, pid };
}

async function cmdStop(): Promise<void> {
  const result = await stopScheduler();
  console.log(result.message);
}

async function cmdAdd(args: string[]): Promise<void> {
  const opts = parseOptions(args);
  const name = String(opts.name ?? "");
  if (!name) fail("Error: --name required.");

  let schedule: Schedule;
  if (typeof opts.cron === "string") {
    schedule = { kind: "cron", expr: opts.cron, ...(typeof opts.tz === "string" ? { tz: opts.tz } : {}) };
  } else if (typeof opts.every === "string") {
    schedule = { kind: "every", everyMs: Number(opts.every), anchorMs: Date.now() };
  } else {
    fail("Error: --cron or --every required.");
  }

  let message: string;
  if (opts["message-default"] === true) message = defaultWorkCyclePrompt();
  else if (typeof opts["message-project"] === "string") message = projectWorkCyclePrompt(opts["message-project"]);
  else if (typeof opts.message === "string") message = opts.message;
  else fail("Error: provide --message, --message-default, or --message-project.");

  const payload = {
    message,
    ...(typeof opts.model === "string" ? { model: opts.model } : {}),
    cwd: typeof opts.cwd === "string" ? resolve(opts.cwd) : repoRoot,
  };
  const input: JobCreate = { name, schedule, payload };
  const store = new JobStore();
  const job = await store.add(input);
  console.log(`Added job ${job.name} (${job.id})`);
}

async function cmdList(): Promise<void> {
  const store = new JobStore();
  await store.load();
  for (const job of store.list()) {
    const state = job.enabled ? "enabled" : "disabled";
    console.log(`${job.id}\t${job.name}\t${state}\t${formatSchedule(job.schedule)}\tnext=${job.state.nextRunAtMs ?? "none"}`);
  }
}

async function cmdRemove(id: string): Promise<void> {
  const store = new JobStore();
  const ok = await store.remove(id);
  if (!ok) fail(`Job not found: ${id}`);
  console.log(`Removed ${id}`);
}

async function cmdRun(id: string, args: string[]): Promise<void> {
  const store = new JobStore();
  await store.load();
  const job = store.get(id);
  if (!job) fail(`Job not found: ${id}`);
  const opts = parseOptions(args);
  const runJob: Job = {
    ...job,
    payload: {
      ...job.payload,
      ...(typeof opts.message === "string" ? { message: opts.message } : {}),
      ...(typeof opts.model === "string" ? { model: opts.model } : {}),
      ...(typeof opts.cwd === "string" ? { cwd: resolve(opts.cwd) } : {}),
      ...(typeof opts["max-duration-ms"] === "string" ? { maxDurationMs: Number(opts["max-duration-ms"]) } : {}),
    },
  };
  const result = await executeJob(runJob, "manual");
  await store.updateState(job.id, {
    lastRunAtMs: Date.now(),
    lastStatus: result.ok ? "ok" : "error",
    lastError: result.error ?? null,
    lastDurationMs: result.durationMs,
    runCount: job.state.runCount + 1,
  });
  console.log(result.ok ? "ok" : "error");
  if (result.logFile) console.log(`Log: ${result.logFile}`);
  if (result.error) console.error(result.error);
}

async function cmdSetEnabled(id: string, enabled: boolean): Promise<void> {
  const store = new JobStore();
  await store.setEnabled(id, enabled);
  console.log(`${enabled ? "Enabled" : "Disabled"} ${id}`);
}

async function cmdStatus(): Promise<void> {
  console.log(formatUnifiedStatus(await buildStatus("stopped")));
}

async function cmdHeartbeat(): Promise<void> {
  const approvals = await getPendingApprovals(repoRoot);
  if (approvals.length === 0) {
    console.log("No pending approvals.");
    return;
  }
  const msg = `${approvals.length} pending approval item(s) in APPROVAL_QUEUE.md`;
  console.log(msg);
  await slack.notifyPendingApprovals(repoRoot).catch((err) => {
    console.error(`[slack] Failed to notify: ${err}`);
  });
}

export interface HealthCheckOptions {
  url?: string;
  timeoutMs?: number;
}

export async function runHealthCheck(opts: HealthCheckOptions = {}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = opts.url ?? "http://localhost:8420/api/status";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function cmdCheckHealth(args: string[]): Promise<void> {
  const opts = parseOptions(args);
  const result = await runHealthCheck({
    url: typeof opts.url === "string" ? opts.url : undefined,
    timeoutMs: typeof opts.timeout === "string" ? Number(opts.timeout) : undefined,
  });
  if (result.ok) {
    console.log(`Health check ok (${result.status})`);
    return;
  }
  const msg = `Health check failed${result.status ? ` (${result.status})` : ""}: ${result.error ?? "unhealthy response"}`;
  console.error(msg);
  if (opts.notify === true) await slack.dm(`:warning: ${msg}`).catch(() => {});
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
