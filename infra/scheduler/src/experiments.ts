/** Experiment management: launch, monitor, and stop long-running experiments via progress.json. */

import { readFile, writeFile, readdir, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { validateCommand, validatePidOwnership, SecurityError } from "./security.js";

const RUNNER_SCRIPT = new URL("../../experiment-runner/run.py", import.meta.url).pathname;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExperimentProgress {
  status: "running" | "stopping" | "completed" | "failed" | "interrupted" | "retrying" | "canary" | "canary_failed";
  pid?: number;
  child_pid?: number;
  command?: string[];
  started_at?: string;
  updated_at?: string;
  finished_at?: string;
  duration_s?: number;
  log_file?: string;
  watch_csv?: string;
  total?: number;
  current?: number;
  pct?: number;
  message?: string;
  error?: string;
  exit_code?: number;
  experiment_dir?: string;
  failure_class?: "transient" | "transient_exhausted" | "permanent";
  attempt?: number;
  max_retries?: number;
}

export interface ExperimentInfo {
  project: string;
  id: string;
  dir: string;
  progress: ExperimentProgress | null;
  /** From EXPERIMENT.md frontmatter */
  mdStatus?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Check if a process is alive using kill signal 0. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Read progress ────────────────────────────────────────────────────────────

async function readProgressJson(experimentDir: string): Promise<ExperimentProgress | null> {
  try {
    const raw = await readFile(join(experimentDir, "progress.json"), "utf-8");
    return JSON.parse(raw) as ExperimentProgress;
  } catch {
    return null;
  }
}

/** Extract status from EXPERIMENT.md YAML frontmatter. */
async function readExperimentMdStatus(experimentDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(experimentDir, "EXPERIMENT.md"), "utf-8");
    const match = raw.match(/^---\n[\s\S]*?status:\s*(\S+)/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

// ── List experiments ─────────────────────────────────────────────────────────

export async function listExperiments(
  repoDir: string,
  projectFilter?: string,
): Promise<ExperimentInfo[]> {
  const results: ExperimentInfo[] = [];
  const projectsDir = join(repoDir, "projects");

  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return results;
  }

  for (const project of projects) {
    if (projectFilter && project !== projectFilter) continue;

    const expDir = join(projectsDir, project, "experiments");
    let experiments: string[];
    try {
      experiments = await readdir(expDir);
    } catch {
      continue;
    }

    for (const expId of experiments) {
      const dir = join(expDir, expId);
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }

      const progress = await readProgressJson(dir);
      const mdStatus = await readExperimentMdStatus(dir);
      results.push({ project, id: expId, dir, progress, mdStatus });
    }
  }

  return results;
}

// ── Launch experiment ────────────────────────────────────────────────────────

export interface LaunchOpts {
  experimentDir: string;
  command: string[];
  projectDir?: string;
  watchCsv?: string;
  total?: number;
  maxRetries?: number;
  retryDelay?: number;
}

// Shell metacharacters that indicate a command was meant to be run through a shell,
// not as an argv array. When these appear as separate tokens in a command array,
// it means a shell command string was naively split on whitespace.
const SHELL_OPERATORS = new Set(["&&", "||", "|", ";", ">", ">>", "<", "<<", "&"]);
const SHELL_BUILTINS = new Set(["cd", "export", "source", "."]);

/**
 * Detect and fix shell commands that were naively split on whitespace.
 * If the command array contains shell operators or starts with a shell builtin,
 * reconstruct the original shell string and wrap in `bash -c`.
 */
export function normalizeShellCommand(command: string[]): string[] {
  if (command.length === 0) return command;

  const hasShellOperator = command.some((arg) => SHELL_OPERATORS.has(arg));
  const startsWithBuiltin = SHELL_BUILTINS.has(command[0]);

  if (!hasShellOperator && !startsWithBuiltin) return command;

  // Reconstruct the original shell command string and wrap in bash -c
  const shellString = command.join(" ");
  return ["bash", "-c", shellString];
}

export async function launchExperiment(opts: LaunchOpts): Promise<{ pid: number }> {
  // Normalize shell commands: if the command array contains shell syntax
  // (&&, ||, pipes, cd, export), wrap in bash -c. This handles the case where
  // chat agents produce shell command strings that get naively split on whitespace.
  const command = normalizeShellCommand(opts.command);

  // Security: validate the command before executing.
  // Allow shells — experiment scripts are .sh files run via run.py.
  validateCommand(command, { allowShells: true });

  const args = [
    RUNNER_SCRIPT,
    "--detach",
    opts.experimentDir,
  ];

  if (opts.projectDir) {
    args.splice(1, 0, "--project-dir", opts.projectDir);
  }
  if (opts.watchCsv) {
    args.splice(1, 0, "--watch-csv", opts.watchCsv);
  }
  if (opts.total) {
    args.splice(1, 0, "--total", String(opts.total));
  }
  if (opts.maxRetries) {
    args.splice(1, 0, "--max-retries", String(opts.maxRetries));
  }
  if (opts.retryDelay !== undefined && opts.retryDelay !== 10) {
    args.splice(1, 0, "--retry-delay", String(opts.retryDelay));
  }

  args.push("--");
  args.push(...command);

  const proc = spawn("python3", args, {
    cwd: opts.experimentDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  return new Promise((resolve, reject) => {
    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Runner exited with code ${code}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve({ pid: result.pid });
      } catch {
        reject(new Error(`Failed to parse runner output: ${stdout}`));
      }
    });
    proc.on("error", reject);
    proc.unref();
  });
}

// ── Stop experiment ──────────────────────────────────────────────────────────

export async function stopExperiment(experimentDir: string): Promise<boolean> {
  const progress = await readProgressJson(experimentDir);
  if (!progress) return false;

  const pid = progress.child_pid ?? progress.pid;
  if (!pid) return false;

  if (progress.status !== "running" && progress.status !== "stopping") {
    return false;
  }

  // Security: verify the process belongs to the current user
  const owned = await validatePidOwnership(pid);
  if (!owned) {
    console.error(`[security] Refusing to kill PID ${pid}: not owned by current user`);
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

// ── Read log tail ────────────────────────────────────────────────────────────

export async function tailLog(experimentDir: string, lines = 20): Promise<string> {
  const logPath = join(experimentDir, "output.log");
  try {
    const content = await readFile(logPath, "utf-8");
    const allLines = content.split("\n");
    const tail = allLines.slice(-lines).join("\n");
    return tail || "(empty log)";
  } catch {
    return "(no log file)";
  }
}

// ── Format for Slack ─────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Experiment completion watcher ──────────────────────────────────────────────

export interface ExperimentEvent {
  project: string;
  id: string;
  status: string;
  progress: ExperimentProgress;
}

type ExperimentEventCallback = (event: ExperimentEvent) => void;

/** Callback fired when a new experiment starts being tracked (via API or disk discovery). */
type NewExperimentCallback = (info: { project: string; id: string; dir: string; source: "api" | "discovery" }) => void;

interface TrackedExperiment {
  dir: string;
  project: string;
  id: string;
  /** When this experiment was first tracked (for adaptive polling). */
  trackedSince: number;
}

const trackedExperiments = new Map<string, TrackedExperiment>();
let watcherTimeout: ReturnType<typeof setTimeout> | null = null;
let experimentCallback: ExperimentEventCallback | null = null;
let newExperimentCallback: NewExperimentCallback | null = null;

// Adaptive polling: fast when experiments are young (catching early crashes),
// slow when they've been running a while (steady state).
const FAST_INTERVAL_MS = 10_000;   // 10s — first 5 minutes
const SLOW_INTERVAL_MS = 60_000;   // 60s — after 5 minutes
const FAST_PHASE_MS = 5 * 60_000;  // 5 minutes of fast polling per experiment

/** Set a callback to be notified when new experiments are tracked. */
export function setNewExperimentCallback(cb: NewExperimentCallback | null): void {
  newExperimentCallback = cb;
}

/** Register an experiment for completion tracking. Resets to fast polling. */
export function trackExperiment(dir: string, project: string, id: string): void {
  const key = `${project}/${id}`;
  const isNew = !trackedExperiments.has(key);
  trackedExperiments.set(key, { dir, project, id, trackedSince: Date.now() });
  // A new experiment was added — reschedule to fast interval immediately
  scheduleNextPoll(FAST_INTERVAL_MS);
  if (isNew) {
    newExperimentCallback?.({ project, id, dir, source: "api" });
  }
}

let watcherRepoDir: string | null = null;

/** Start polling tracked experiments. Calls back when any leaves "running" state.
 *  Also discovers running experiments on disk (resilient to CLI launches and restarts).
 *  Uses adaptive polling: 10s for the first 5 min per experiment, then 60s. */
export function startExperimentWatcher(cb: ExperimentEventCallback, _intervalMs?: number, repoDir?: string): void {
  experimentCallback = cb;
  if (repoDir) watcherRepoDir = repoDir;
  if (watcherTimeout) { clearTimeout(watcherTimeout); watcherTimeout = null; }
  // Discover on startup, then start adaptive poll loop
  discoverRunningExperiments().catch((err) => console.error(`[experiments] Discovery error:`, err));
  scheduleNextPoll(FAST_INTERVAL_MS);
}

/** Schedule the next poll at the appropriate interval based on tracked experiments. */
function scheduleNextPoll(overrideMs?: number): void {
  if (watcherTimeout) clearTimeout(watcherTimeout);
  const interval = overrideMs ?? computePollInterval();
  watcherTimeout = setTimeout(async () => {
    await pollTrackedExperiments();
    // Continue the loop
    if (experimentCallback) scheduleNextPoll();
  }, interval);
}

/** Compute poll interval: fast if any experiment is in its early phase, slow otherwise. */
function computePollInterval(): number {
  const now = Date.now();
  for (const exp of trackedExperiments.values()) {
    if (now - exp.trackedSince < FAST_PHASE_MS) return FAST_INTERVAL_MS;
  }
  // No young experiments — but still poll (for discovery and PID liveness)
  return trackedExperiments.size > 0 ? SLOW_INTERVAL_MS : SLOW_INTERVAL_MS;
}

/** Keys we've already emitted events for (prevents duplicate notifications on re-discovery). */
const emittedKeys = new Set<string>();

/** Scan all experiments on disk and auto-track any with status "running"/"stopping".
 *  Also emits events for recently-finished experiments (within 2 min) that were missed
 *  (e.g. due to a restart). */
async function discoverRunningExperiments(): Promise<void> {
  if (!watcherRepoDir) return;
  const experiments = await listExperiments(watcherRepoDir);
  const RECENT_MS = 7 * 60 * 1000; // 7 minutes — must exceed discovery interval (6 polls × 60s = 6 min)

  for (const exp of experiments) {
    const key = `${exp.project}/${exp.id}`;
    if (trackedExperiments.has(key)) continue;

    if (exp.progress?.status === "running" || exp.progress?.status === "stopping" || exp.progress?.status === "retrying") {
      // Use started_at for accurate age (affects adaptive polling interval)
      const trackedSince = exp.progress.started_at
        ? new Date(exp.progress.started_at).getTime()
        : Date.now();
      console.log(`[experiments] Auto-discovered running experiment: ${key}`);
      trackedExperiments.set(key, { dir: exp.dir, project: exp.project, id: exp.id, trackedSince });
      newExperimentCallback?.({ project: exp.project, id: exp.id, dir: exp.dir, source: "discovery" });
    } else if (
      exp.progress &&
      (exp.progress.status === "completed" || exp.progress.status === "failed" || exp.progress.status === "interrupted" || exp.progress.status === "canary_failed") &&
      exp.progress.finished_at &&
      !emittedKeys.has(key)
    ) {
      // Emit event for recently-finished experiments we might have missed during restart
      const finishedAgo = Date.now() - new Date(exp.progress.finished_at).getTime();
      if (finishedAgo < RECENT_MS) {
        console.log(`[experiments] Emitting missed ${exp.progress.status} event for ${key} (finished ${Math.round(finishedAgo / 1000)}s ago)`);
        emittedKeys.add(key);
        experimentCallback?.({ project: exp.project, id: exp.id, status: exp.progress.status, progress: exp.progress });
      }
    }
  }
}

export function stopExperimentWatcher(): void {
  if (watcherTimeout) { clearTimeout(watcherTimeout); watcherTimeout = null; }
  experimentCallback = null;
  newExperimentCallback = null;
  trackedExperiments.clear();
}

let pollCount = 0;
const DISCOVERY_EVERY_N_POLLS = 6; // re-discover every ~6 polls (60s at slow, 60s at fast)

async function pollTrackedExperiments(): Promise<void> {
  // Periodically re-discover to catch CLI-launched experiments
  pollCount++;
  if (pollCount % DISCOVERY_EVERY_N_POLLS === 0) {
    await discoverRunningExperiments().catch((err) => console.error(`[experiments] Discovery error:`, err));
  }

  for (const [key, exp] of trackedExperiments) {
    const progress = await readProgressJson(exp.dir);
    if (!progress) continue;

    if (progress.status === "running" || progress.status === "stopping" || progress.status === "retrying") {
      // Check if the process is actually alive
      const pid = progress.child_pid ?? progress.pid;
      if (pid && !isPidAlive(pid)) {
        console.warn(`[experiments] PID ${pid} for ${key} is dead but status is "${progress.status}" — marking failed`);
        const updated: ExperimentProgress = {
          ...progress,
          status: "failed",
          error: `Process ${pid} died without updating progress.json`,
          updated_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        };
        // Atomic write: tmp + rename
        const tmpPath = join(exp.dir, "progress.json.tmp");
        const finalPath = join(exp.dir, "progress.json");
        await writeFile(tmpPath, JSON.stringify(updated, null, 2) + "\n");
        await rename(tmpPath, finalPath);
        trackedExperiments.delete(key);
        emittedKeys.add(key);
        experimentCallback?.({ project: exp.project, id: exp.id, status: "failed", progress: updated });
      }
    } else {
      trackedExperiments.delete(key);
      emittedKeys.add(key);
      experimentCallback?.({ project: exp.project, id: exp.id, status: progress.status, progress });
    }
  }
}

// ── Format for Slack ─────────────────────────────────────────────────────────

export function formatExperimentStatus(experiments: ExperimentInfo[]): string {
  if (experiments.length === 0) return "No experiments found.";

  // Sort: running first, then by most recently updated
  const sorted = [...experiments].sort((a, b) => {
    const aRunning = (a.progress?.status === "running" || a.progress?.status === "retrying") ? 0 : 1;
    const bRunning = (b.progress?.status === "running" || b.progress?.status === "retrying") ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    const aTime = a.progress?.updated_at ?? "";
    const bTime = b.progress?.updated_at ?? "";
    return bTime.localeCompare(aTime);
  });

  const lines: string[] = [];
  for (const exp of sorted) {
    const p = exp.progress;
    const status = p?.status ?? exp.mdStatus ?? "unknown";
    const icon = status === "running" ? ":arrow_forward:" :
                 status === "retrying" ? ":repeat:" :
                 status === "completed" ? ":white_check_mark:" :
                 status === "failed" ? ":x:" :
                 status === "canary_failed" ? ":warning:" :
                 status === "canary" ? ":test_tube:" :
                 status === "interrupted" ? ":stop_sign:" :
                 status === "stopping" ? ":hourglass:" : ":grey_question:";

    let line = `${icon} *${exp.project}/${exp.id}* — ${status}`;

    if ((p?.status === "running" || p?.status === "retrying") && p.pct !== undefined) {
      line += ` (${p.pct}%`;
      if (p.message) line += ` — ${p.message}`;
      line += `)`;
    }

    if (p?.attempt && p.max_retries && p.max_retries > 0) {
      line += ` [attempt ${p.attempt}/${p.max_retries + 1}]`;
    }

    if (p?.duration_s) {
      line += ` [${formatDuration(p.duration_s)}]`;
    } else if (p?.started_at && p.status === "running") {
      const elapsed = Math.round((Date.now() - new Date(p.started_at).getTime()) / 1000);
      line += ` [${formatDuration(elapsed)}]`;
    }

    lines.push(line);
  }

  return lines.join("\n");
}
