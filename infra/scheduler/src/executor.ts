/** Executes a scheduled agent session. */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Job } from "./types.js";
import { resolveBackend } from "./backend.js";
import { runtimeRouteForBackend, type RuntimeRoute } from "./runtime.js";
import { spawnAgent, AGENT_PROFILES, resolveProfileForBackend } from "./agent.js";
import type { ModelUsageStats } from "./sdk.js";
import { notifySessionStarted, notifySessionComplete } from "./slack.js";
import { getPendingApprovals } from "./notify.js";

const exec = promisify(execFile);
const LOGS_DIR = new URL("../../../.scheduler/logs", import.meta.url).pathname;
export const UNCOMMITTED_FILE_WARNING_THRESHOLD = 50;

export interface ExecutionResult {
  ok: boolean;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  error?: string;
  logFile?: string;
  costUsd?: number;
  numTurns?: number;
  runtime?: RuntimeRoute;
  timedOut?: boolean;
  sessionId?: string;
  triggerSource?: "scheduler" | "slack" | "manual" | "fleet";
  modelUsage?: Record<string, ModelUsageStats>;
  toolCounts?: Record<string, number>;
  orientTurns?: number;
  sleepViolation?: string;
  stallViolation?: string;
}

function formatTokenCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatExecutionSummary(agentResult: {
  durationMs: number;
  costUsd: number;
  numTurns: number;
  modelUsage?: Record<string, ModelUsageStats>;
}): string {
  let line = `# Duration: ${Math.round(agentResult.durationMs / 1000)}s, Cost: $${agentResult.costUsd.toFixed(4)}, Turns: ${agentResult.numTurns}`;
  if (agentResult.modelUsage) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    for (const usage of Object.values(agentResult.modelUsage)) {
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;
      cachedInputTokens += usage.cacheReadInputTokens ?? 0;
    }
    if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
      line += `, Tokens: ${formatTokenCount(inputTokens + outputTokens)} total (${formatTokenCount(inputTokens)} in, ${formatTokenCount(outputTokens)} out`;
      if (cachedInputTokens > 0) line += `, ${formatTokenCount(cachedInputTokens)} cached`;
      line += ")";
    }
  }
  return line;
}

function buildLogFilePath(jobName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(LOGS_DIR, `${jobName}-${ts}.log`);
}

async function writeExecutionLog(opts: {
  jobName: string;
  runtime: RuntimeRoute;
  summary: { durationMs: number; costUsd: number; numTurns: number; modelUsage?: Record<string, ModelUsageStats> };
  output: string;
}): Promise<string> {
  const logFile = buildLogFilePath(opts.jobName);
  await mkdir(LOGS_DIR, { recursive: true });
  await writeFile(
    logFile,
    `# ${opts.jobName} — ${new Date().toISOString()}\n# Runtime: ${opts.runtime}\n${formatExecutionSummary(opts.summary)}\n\n## output\n${opts.output}\n`,
  );
  return logFile;
}

async function writeErrorLog(opts: {
  jobName: string;
  runtime: RuntimeRoute;
  durationMs: number;
  error: string;
}): Promise<string> {
  const logFile = buildLogFilePath(opts.jobName);
  await mkdir(LOGS_DIR, { recursive: true });
  await writeFile(
    logFile,
    `# ${opts.jobName} — ${new Date().toISOString()}\n# Runtime: ${opts.runtime}\n# Duration: ${Math.round(opts.durationMs / 1000)}s, ERROR\n\n## error\n${opts.error}\n`,
  );
  return logFile;
}

export async function checkUncommittedFileThreshold(cwd: string): Promise<void> {
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd });
    const count = stdout.split("\n").filter((line) => line.trim() !== "").length;
    if (count > UNCOMMITTED_FILE_WARNING_THRESHOLD) {
      console.warn(`[executor] WARNING: ${count} uncommitted files detected (threshold: ${UNCOMMITTED_FILE_WARNING_THRESHOLD}).`);
    }
  } catch (err) {
    console.error("[executor] Failed to check uncommitted file count:", err);
  }
}

export async function executeJob(
  job: Job,
  triggerSource: "scheduler" | "slack" | "manual" = "scheduler",
): Promise<ExecutionResult> {
  const start = Date.now();
  const cwd = job.payload.cwd ?? process.cwd();
  const backend = resolveBackend({
    model: job.payload.model,
    requiredCapabilities: job.payload.requiredCapabilities,
  });
  const runtime = runtimeRouteForBackend(backend.name);
  const baseProfile = AGENT_PROFILES.workSession;
  const profile = resolveProfileForBackend({
    ...baseProfile,
    model: job.payload.model ?? baseProfile.model,
    maxDurationMs: job.payload.maxDurationMs ?? baseProfile.maxDurationMs,
  }, backend.name);

  await checkUncommittedFileThreshold(cwd);
  const threadInfo = await notifySessionStarted(job.name, job.id).catch(() => null);

  try {
    const { sessionId, result } = spawnAgent({
      profile,
      prompt: job.payload.message,
      cwd,
      requiredCapabilities: job.payload.requiredCapabilities,
      jobId: job.id,
      jobName: job.name,
    });
    const agentResult = await result;
    const logFile = await writeExecutionLog({
      jobName: job.name,
      runtime,
      summary: agentResult,
      output: agentResult.text,
    });
    const execution: ExecutionResult = {
      ok: !agentResult.timedOut && !agentResult.sleepViolation && !agentResult.stallViolation,
      durationMs: agentResult.durationMs,
      exitCode: agentResult.timedOut ? 124 : 0,
      stdout: agentResult.text,
      logFile,
      costUsd: agentResult.costUsd,
      numTurns: agentResult.numTurns,
      runtime,
      timedOut: agentResult.timedOut,
      sessionId,
      triggerSource,
      modelUsage: agentResult.modelUsage,
      toolCounts: agentResult.toolCounts,
      orientTurns: agentResult.orientTurns,
      sleepViolation: agentResult.sleepViolation,
      stallViolation: agentResult.stallViolation,
    };
    const approvals = await getPendingApprovals(cwd).catch(() => []);
    await notifySessionComplete(job, execution, approvals, threadInfo?.threadTs).catch(() => {});
    return execution;
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    const logFile = await writeErrorLog({ jobName: job.name, runtime, durationMs, error });
    const execution: ExecutionResult = {
      ok: false,
      durationMs,
      exitCode: 1,
      stdout: "",
      error,
      logFile,
      runtime,
      triggerSource,
    };
    const approvals = await getPendingApprovals(cwd).catch(() => []);
    await notifySessionComplete(job, execution, approvals, threadInfo?.threadTs).catch(() => {});
    return execution;
  }
}
