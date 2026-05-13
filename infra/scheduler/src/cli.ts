#!/usr/bin/env node
/** CLI for the trimmed a-exp scheduler. */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolRoot = resolve(__dirname, "../../..");
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

loadEnvFile(resolve(toolRoot, "infra/.env"));
loadEnvFile(resolve(toolRoot, "infra/scheduler/.env"));

import { JobStore } from "./store.js";
import { SchedulerService } from "./service.js";
import { executeJob } from "./executor.js";
import { getPendingApprovals } from "./notify.js";
import * as slack from "./slack.js";
import { setChannelModesPath } from "./channel-mode.js";
import { setModelPreferencePath, setLegacyBackendPreferencePath } from "./model-preference.js";
import { listSessions } from "./session.js";
import { listExperiments } from "./experiments.js";
import { getUnifiedStatus, formatUnifiedStatus, toStatusExperiment, type StatusJob } from "./status.js";
import { startApiServer, stopApiServer } from "./api/server.js";
import {
  checkForExistingInstance,
  acquireLock,
  releaseLock,
  getSchedulerLockfilePath,
  getDaemonStateFromLockfile,
  isPidAlive,
} from "./instance-guard.js";
import { initWorkspace, legacyWorkspacePaths, resolveWorkspace, type Workspace } from "./workspace.js";
import type { Job, JobCreate, Schedule } from "./types.js";

const HELP = `
a-exp — Cron scheduler for a-exp Core

Commands:
  init --project <name>     Initialize an a-exp project workspace in this repo
  project <file>            Run the project skill from a description file
  kanban [project]          Run the kanban skill for project summaries
  packet <project> <target> Run the packet skill for an implementation handoff
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

Global options:
  --repo <dir>              Target workspace repo (default: discover from cwd)

Init options:
  --project <name>          Default project name to scaffold

Start options:
  --foreground              Run the scheduler in the current terminal

Project options:
  --mode <mode>             Override file Mode: scaffold, augment, or propose
  --model <model>           Model name
  --max-duration-ms <ms>    Override max session duration
  --dry-run                 Print the project-skill prompt without running it

Kanban options:
  --output-dir <dir>        Output directory for generated summaries
  --max-cost-items <n>      Limit cost/session items per summary
  --max-result-bullets <n>  Limit result bullets per card
  --model <model>           Model name
  --max-duration-ms <ms>    Override max session duration
  --dry-run                 Print the kanban-skill prompt without running it

Packet options:
  --model <model>           Model name
  --max-duration-ms <ms>    Override max session duration
  --dry-run                 Print the packet-skill prompt without running it

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

function parseOptions(args: string[], booleanOptions = new Set<string>()): Record<string, string | true> {
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (booleanOptions.has(key)) {
      opts[key] = true;
      continue;
    }
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

function positionalArgs(args: string[], booleanOptions = new Set<string>()): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg.includes("=")) continue;
    const key = arg.slice(2);
    if (booleanOptions.has(key)) continue;
    const next = args[i + 1];
    if (next && !next.startsWith("--")) i++;
  }
  return positional;
}

function extractGlobalOptions(args: string[]): { repo?: string; args: string[] } {
  const remaining: string[] = [];
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo" && args[i + 1]) {
      repo = args[++i];
      continue;
    }
    if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
      continue;
    }
    remaining.push(arg);
  }
  return { repo, args: remaining };
}

function requireWorkspace(repo?: string): Workspace {
  const workspace = resolveWorkspace({ repo });
  if (!workspace) {
    fail("No a-exp workspace found. Run `a-exp init --project <name>` first, or pass --repo <dir>.");
  }
  return workspace;
}

function configureWorkspaceRuntime(workspace: Workspace): void {
  loadEnvFile(join(workspace.stateDir, ".env"));
  if (workspace.root === toolRoot) {
    loadEnvFile(resolve(toolRoot, "infra/.env"));
    loadEnvFile(resolve(toolRoot, "infra/scheduler/.env"));
  }
  setChannelModesPath(workspace.channelModesPath);
  setModelPreferencePath(workspace.modelPreferencePath);
  setLegacyBackendPreferencePath(workspace.legacyBackendPreferencePath);
}

function legacyPathsFor(workspace: Workspace): Workspace | null {
  if (existsSync(workspace.stateDir)) return null;
  if (existsSync(workspace.legacyStateDir)) return legacyWorkspacePaths(workspace.root);
  return null;
}

function storeFor(workspace: Workspace): JobStore {
  return new JobStore(workspace.jobsPath, legacyPathsFor(workspace)?.jobsPath ?? null);
}

function defaultWorkCyclePrompt(): string {
  return [
    "Run one a-exp work cycle.",
    "Read AGENTS.md, inspect project README/TASKS files, select one actionable task, execute it, update project memory, verify, and commit the completed logical unit.",
  ].join("\n");
}

function projectWorkCyclePrompt(project: string): string {
  return [
    `Run one a-exp work cycle scoped to projects/${project}.`,
    "Read the project README and TASKS, select one actionable task, execute it, update project memory, verify, and commit the completed logical unit.",
  ].join("\n");
}

export interface ProjectDescription {
  title?: string;
  mode: "scaffold" | "augment" | "propose";
  project?: string;
  content: string;
}

const PROJECT_MODES = new Set(["scaffold", "augment", "propose"]);

function normalizeProjectMode(mode: string | undefined): ProjectDescription["mode"] {
  const raw = (mode ?? "scaffold").trim().toLowerCase();
  const normalized = raw.split(/[\s(]/, 1)[0] || "scaffold";
  if (!PROJECT_MODES.has(normalized)) {
    fail(`Error: invalid project mode "${mode}". Expected scaffold, augment, or propose.`);
  }
  return normalized as ProjectDescription["mode"];
}

export function parseProjectDescriptionFile(content: string, opts: { modeOverride?: string } = {}): ProjectDescription {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const headers: Record<string, string> = {};
  let contentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      contentStart = i + 1;
      break;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      contentStart = i;
      break;
    }
    headers[match[1].toLowerCase()] = match[2].trim();
    contentStart = i + 1;
  }

  const mode = normalizeProjectMode(opts.modeOverride ?? headers.mode);
  return {
    title: headers.title || undefined,
    mode,
    project: headers.project || undefined,
    content: lines.slice(contentStart).join("\n").trim(),
  };
}

export function buildProjectSkillPrompt(description: ProjectDescription, sourcePath: string): string {
  const target = description.project ? `Project: ${description.project}` : "Project: not specified";
  const title = description.title ? `Title: ${description.title}` : `Title: ${basename(sourcePath)}`;
  return [
    `Use the project skill in ${description.mode} mode using the description file at ${sourcePath}.`,
    "",
    "Treat the description file as human-provided project input and as answers to the project-skill interview where it is specific enough.",
    "If required information is missing, ask concise follow-up questions and do not edit files yet.",
    "If the request is sufficiently specified, follow the project skill workflow: check for overlap, make the minimal project-memory changes, present the delta when required by the skill, verify, update logs, and commit the completed logical unit.",
    "",
    title,
    `Mode: ${description.mode}`,
    target,
    "",
    "Description:",
    description.content || "(No body content provided.)",
  ].join("\n");
}

export interface KanbanOptions {
  project?: string;
  outputDir?: string;
  maxCostItems?: string;
  maxResultBullets?: string;
}

export function buildKanbanSkillPrompt(opts: KanbanOptions): string {
  const scope = opts.project ? `Project: ${opts.project}` : "Project: all projects";
  const output = opts.outputDir ? `Output directory: ${opts.outputDir}` : "Output directory: reports/kanban";
  const maxCost = opts.maxCostItems ? `Max cost items: ${opts.maxCostItems}` : "Max cost items: skill default";
  const maxResult = opts.maxResultBullets ? `Max result bullets: ${opts.maxResultBullets}` : "Max result bullets: skill default";
  return [
    "Use the kanban skill to generate compressed Obsidian-kanban-friendly project summaries.",
    "",
    scope,
    output,
    maxCost,
    maxResult,
    "",
    "Follow the kanban skill workflow: read project TASKS, logs, experiment records, reports, and matching packet files; generate the requested Markdown summaries; inspect the output; tighten wording if needed; verify; update the relevant project log; and commit the completed logical unit.",
    "Keep paths relative to the repo root and do not invent cost attribution.",
  ].join("\n");
}

export interface PacketOptions {
  project: string;
  targetPackage: string;
  instructions?: string;
}

export function buildPacketSkillPrompt(opts: PacketOptions): string {
  return [
    "Use the packet skill to create an implementation-ready algorithm handoff packet.",
    "",
    `Project: ${opts.project}`,
    `Target package: ${opts.targetPackage}`,
    `Additional instructions: ${opts.instructions?.trim() || "none"}`,
    "",
    "Follow the packet skill workflow: read target package instructions and relevant APIs first; read the a-exp project context, experiments, reports, and prototype module; identify the verified prototype contract; map it to the target package conventions; write the packet under reports/packet/ unless instructed otherwise; verify the packet quality; update the relevant project log; and commit the completed logical unit.",
    "Ask one concise question instead of editing if a required argument or target direction is ambiguous.",
  ].join("\n");
}

async function runManualSkillJob(opts: {
  workspace: Workspace;
  name: string;
  message: string;
  model?: string;
  maxDurationMs?: string;
}): Promise<void> {
  const job: Job = {
    id: `${opts.name}-${Date.now().toString(36)}`,
    name: opts.name,
    schedule: { kind: "every", everyMs: 0 },
    payload: {
      message: opts.message,
      cwd: opts.workspace.root,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxDurationMs ? { maxDurationMs: Number(opts.maxDurationMs) } : {}),
    },
    enabled: true,
    createdAtMs: Date.now(),
    state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, lastError: null, lastDurationMs: null, runCount: 0 },
  };

  const result = await executeJob(job, "manual", { logsDir: opts.workspace.logsDir });
  console.log(result.ok ? "ok" : "error");
  if (result.logFile) console.log(`Log: ${result.logFile}`);
  if (result.error) console.error(result.error);
  if (!result.ok) process.exitCode = 1;
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

async function buildStatus(workspace: Workspace, daemonState: "running" | "stopped") {
  const store = storeFor(workspace);
  await store.load();
  const experiments = await listExperiments(workspace.root);
  return getUnifiedStatus({
    sessions: listSessions(),
    experiments: experiments.map((e) => toStatusExperiment(e)),
    jobs: store.list().map(toStatusJob),
    daemonState,
  });
}

export function getDaemonState(workspace: Pick<Workspace, "lockDir">): "running" | "stopped" {
  return getDaemonStateFromLockfile(getSchedulerLockfilePath(workspace.lockDir));
}

async function main(): Promise<void> {
  const parsed = extractGlobalOptions(process.argv.slice(2));
  const args = parsed.args;
  const cmd = args[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  if (cmd === "init") return cmdInit(args.slice(1), parsed.repo);
  if (cmd === "project") return cmdProject(args.slice(1), parsed.repo);
  if (cmd === "kanban") return cmdKanban(args.slice(1), parsed.repo);
  if (cmd === "packet") return cmdPacket(args.slice(1), parsed.repo);
  if (cmd === "start") return cmdStart(args.slice(1), parsed.repo);
  if (cmd === "stop") return cmdStop(parsed.repo);
  if (cmd === "add") return cmdAdd(args.slice(1), parsed.repo);
  if (cmd === "list") return cmdList(parsed.repo);
  if (cmd === "remove") return cmdRemove(requireArg(args[1], "job ID"), parsed.repo);
  if (cmd === "run") return cmdRun(requireArg(args[1], "job ID"), args.slice(2), parsed.repo);
  if (cmd === "enable") return cmdSetEnabled(requireArg(args[1], "job ID"), true, parsed.repo);
  if (cmd === "disable") return cmdSetEnabled(requireArg(args[1], "job ID"), false, parsed.repo);
  if (cmd === "status") return cmdStatus(parsed.repo);
  if (cmd === "heartbeat") return cmdHeartbeat(parsed.repo);
  if (cmd === "check-health") return cmdCheckHealth(args.slice(1), parsed.repo);
  return fail(`Unknown command: ${cmd}\n\n${HELP}`);
}

async function cmdInit(args: string[], repo?: string): Promise<void> {
  const opts = parseOptions(args);
  const project = typeof opts.project === "string" ? opts.project.trim() : "";
  if (!project) fail("Error: --project required.");
  const root = repo ? resolve(repo) : process.cwd();
  const created = await initWorkspace(root, project);
  console.log(`Initialized a-exp workspace at ${root}`);
  if (created.length === 0) {
    console.log("No files created; existing workspace scaffold was left unchanged.");
    return;
  }
  for (const path of created) console.log(`  created ${path}`);
}

async function cmdProject(args: string[], repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
  const opts = parseOptions(args, new Set(["dry-run"]));
  const fileArg = positionalArgs(args, new Set(["dry-run"]))[0];
  if (!fileArg) fail("Error: description file required.");

  const sourcePath = resolve(fileArg);
  if (!existsSync(sourcePath)) fail(`Error: description file not found: ${sourcePath}`);

  const description = parseProjectDescriptionFile(readFileSync(sourcePath, "utf-8"), {
    modeOverride: typeof opts.mode === "string" ? opts.mode : undefined,
  });
  if (description.mode === "augment" && !description.project) {
    fail("Error: augment mode requires a Project: header in the description file.");
  }

  const message = buildProjectSkillPrompt(description, sourcePath);
  if (opts["dry-run"] === true) {
    console.log(message);
    return;
  }

  await runManualSkillJob({
    workspace,
    name: `project-${description.mode}`,
    message,
    model: typeof opts.model === "string" ? opts.model : undefined,
    maxDurationMs: typeof opts["max-duration-ms"] === "string" ? opts["max-duration-ms"] : undefined,
  });
}

async function cmdKanban(args: string[], repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
  const opts = parseOptions(args, new Set(["dry-run"]));
  const project = positionalArgs(args, new Set(["dry-run"]))[0];
  const message = buildKanbanSkillPrompt({
    project,
    outputDir: typeof opts["output-dir"] === "string" ? opts["output-dir"] : undefined,
    maxCostItems: typeof opts["max-cost-items"] === "string" ? opts["max-cost-items"] : undefined,
    maxResultBullets: typeof opts["max-result-bullets"] === "string" ? opts["max-result-bullets"] : undefined,
  });
  if (opts["dry-run"] === true) {
    console.log(message);
    return;
  }

  await runManualSkillJob({
    workspace,
    name: "kanban",
    message,
    model: typeof opts.model === "string" ? opts.model : undefined,
    maxDurationMs: typeof opts["max-duration-ms"] === "string" ? opts["max-duration-ms"] : undefined,
  });
}

async function cmdPacket(args: string[], repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
  const opts = parseOptions(args, new Set(["dry-run"]));
  const positionals = positionalArgs(args, new Set(["dry-run"]));
  const project = positionals[0];
  const targetPackage = positionals[1];
  if (!project) fail("Error: project required.");
  if (!targetPackage) fail("Error: target package path required.");

  const message = buildPacketSkillPrompt({
    project,
    targetPackage: resolve(targetPackage),
    instructions: positionals.slice(2).join(" "),
  });
  if (opts["dry-run"] === true) {
    console.log(message);
    return;
  }

  await runManualSkillJob({
    workspace,
    name: "packet",
    message,
    model: typeof opts.model === "string" ? opts.model : undefined,
    maxDurationMs: typeof opts["max-duration-ms"] === "string" ? opts["max-duration-ms"] : undefined,
  });
}

export function buildStartForegroundArgs(cliPath: string, workspaceRoot: string): string[] {
  return [cliPath, "--repo", workspaceRoot, "start", "--foreground"];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDaemonStart(workspace: Workspace, child: ReturnType<typeof spawn>, timeoutMs = 5_000): Promise<boolean> {
  let exited = false;
  child.once("exit", () => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getDaemonState(workspace) === "running") return true;
    if (exited) return false;
    await sleep(100);
  }
  return getDaemonState(workspace) === "running";
}

function removeLockfileBestEffort(lockfile: string): void {
  try { unlinkSync(lockfile); } catch { /* best effort stale lock cleanup */ }
}

async function cmdStart(args: string[], repo?: string): Promise<void> {
  const opts = parseOptions(args, new Set(["foreground"]));
  if (opts.foreground === true) return cmdStartForeground(repo);

  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
  const lockfile = getSchedulerLockfilePath(workspace.lockDir);
  const check = checkForExistingInstance(lockfile);
  if (!check.canStart) fail(check.message);

  mkdirSync(workspace.logsDir, { recursive: true });
  const logFile = join(workspace.logsDir, "daemon.log");
  appendFileSync(logFile, `\n# a-exp daemon start ${new Date().toISOString()}\n`);
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");
  const cliPath = process.argv[1] ? resolve(process.argv[1]) : join(__dirname, "cli.js");
  const child = spawn(process.execPath, buildStartForegroundArgs(cliPath, workspace.root), {
    cwd: workspace.root,
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  child.unref();
  closeSync(out);
  closeSync(err);

  const started = await waitForDaemonStart(workspace, child);
  if (!started) {
    if (getDaemonState(workspace) === "stopped") removeLockfileBestEffort(lockfile);
    fail(`Scheduler daemon did not start. See ${logFile}`);
  }
  console.log(`Scheduler daemon started with PID ${readFileSync(lockfile, "utf-8").trim()}`);
  console.log(`Log: ${logFile}`);
}

async function cmdStartForeground(repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
  const lockfile = getSchedulerLockfilePath(workspace.lockDir);
  const check = checkForExistingInstance(lockfile);
  if (!check.canStart) fail(check.message);
  acquireLock(lockfile);

  const service = new SchedulerService({
    storePath: workspace.jobsPath,
    legacyStorePath: legacyPathsFor(workspace)?.jobsPath ?? null,
    logsDir: workspace.logsDir,
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

  try {
    await slack.startSlackBot({ repoDir: workspace.root }).catch((err) => {
      console.error(`[slack] Failed to start: ${err}`);
    });
    const apiPort = await startApiServer({
      getStatus: () => buildStatus(workspace, "running"),
    });
    console.log(`[api] Listening on http://127.0.0.1:${apiPort}`);
    await service.start();
  } catch (err) {
    service.stop();
    await stopApiServer().catch(() => {});
    releaseLock(lockfile);
    throw err;
  }
}

export async function stopScheduler(repo?: string): Promise<{ ok: boolean; message: string; pid?: number }> {
  const workspace = requireWorkspace(repo);
  const lockfile = getSchedulerLockfilePath(workspace.lockDir);
  if (!existsSync(lockfile)) return { ok: true, message: "Scheduler is not running" };
  const pid = Number(readFileSync(lockfile, "utf-8").trim());
  if (!Number.isFinite(pid) || !isPidAlive(pid)) {
    removeLockfileBestEffort(lockfile);
    return { ok: true, message: "Removed stale scheduler lockfile" };
  }
  process.kill(pid, "SIGTERM");
  return { ok: true, message: `Sent SIGTERM to scheduler PID ${pid}`, pid };
}

async function cmdStop(repo?: string): Promise<void> {
  const result = await stopScheduler(repo);
  console.log(result.message);
}

async function cmdAdd(args: string[], repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
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
    cwd: typeof opts.cwd === "string" ? resolve(opts.cwd) : workspace.root,
  };
  const input: JobCreate = { name, schedule, payload };
  const store = storeFor(workspace);
  const job = await store.add(input);
  console.log(`Added job ${job.name} (${job.id})`);
}

async function cmdList(repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  const store = storeFor(workspace);
  await store.load();
  for (const job of store.list()) {
    const state = job.enabled ? "enabled" : "disabled";
    console.log(`${job.id}\t${job.name}\t${state}\t${formatSchedule(job.schedule)}\tnext=${job.state.nextRunAtMs ?? "none"}`);
  }
}

async function cmdRemove(id: string, repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  const store = storeFor(workspace);
  const ok = await store.remove(id);
  if (!ok) fail(`Job not found: ${id}`);
  console.log(`Removed ${id}`);
}

async function cmdRun(id: string, args: string[], repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
  const store = storeFor(workspace);
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
  const result = await executeJob(runJob, "manual", { logsDir: workspace.logsDir });
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

async function cmdSetEnabled(id: string, enabled: boolean, repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  const store = storeFor(workspace);
  await store.setEnabled(id, enabled);
  console.log(`${enabled ? "Enabled" : "Disabled"} ${id}`);
}

async function cmdStatus(repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
  console.log(formatUnifiedStatus(await buildStatus(workspace, getDaemonState(workspace))));
}

async function cmdHeartbeat(repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
  const approvals = await getPendingApprovals(workspace.root);
  if (approvals.length === 0) {
    console.log("No pending approvals.");
    return;
  }
  const msg = `${approvals.length} pending approval item(s) in APPROVAL_QUEUE.md`;
  console.log(msg);
  await slack.notifyPendingApprovals(workspace.root).catch((err) => {
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

async function cmdCheckHealth(args: string[], repo?: string): Promise<void> {
  const workspace = requireWorkspace(repo);
  configureWorkspaceRuntime(workspace);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
