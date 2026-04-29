/** Unified agent spawning — single entry point for all agent sessions (work, chat, autofix). */

import { resolveBackend, type BackendQueryOpts, type SessionHandle, type BackendName, type BackendCapability } from "./backend.js";
import { runtimeRouteForBackend } from "./runtime.js";
import type { QueryOpts, SDKMessage, ModelUsageStats } from "./sdk.js";
import {
  registerSession,
  unregisterSession,
  getSession,
  bufferMessage,
  summarizeMessage,
  updateSessionStats,
  incrementSessionTurns,
} from "./session.js";
import { isDraining } from "./drain-state.js";
import { checkMessageForSleepViolation } from "./sleep-guard.js";
import { checkMessageForPm2Violation } from "./security.js";
import { StallGuard, extractShellCommands } from "./stall-guard.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentProfile {
  model: string;
  maxTurns?: number;        // undefined = unlimited (SDK default)
  maxDurationMs: number;
  label: string;            // for logging: "work-session", "chat", "autofix"
}

export const AGENT_PROFILES = {
  workSession: { model: "opus", maxDurationMs: 1_800_000, label: "work-session" },
  teamWorkSession: { model: "opus", maxTurns: 256, maxDurationMs: 7_200_000, label: "team-work-session" },
  // Read env var lazily (not at import time) so .env loading in cli.ts takes effect
  chat: { get model() { return process.env["SLACK_CHAT_MODEL"] ?? "sonnet"; }, maxTurns: 16, maxDurationMs: 120_000, label: "chat" },
  autofix: { model: "opus", maxTurns: 32, maxDurationMs: 600_000, label: "autofix" },
  deepWork: { model: "opus", maxTurns: 256, maxDurationMs: 3_600_000, label: "deep-work" },
  skillCycle: { model: "sonnet", maxTurns: 48, maxDurationMs: 900_000, label: "skill-cycle" },
} as const satisfies Record<string, AgentProfile>;

// ── Backend-specific profile overrides ──────────────────────────────────────

type ProfileOverrides = Partial<Pick<AgentProfile, "maxTurns" | "maxDurationMs">>;

export const BACKEND_PROFILE_OVERRIDES: Record<string, Record<string, ProfileOverrides>> = {
};

/** Apply backend-specific overrides to a resolved profile.
 *  Returns a new profile object — the original is not mutated. */
export function resolveProfileForBackend(
  profile: AgentProfile,
  backendName: string,
): AgentProfile {
  const overrides = BACKEND_PROFILE_OVERRIDES[backendName]?.[profile.label];
  if (!overrides) return profile;
  return { ...profile, ...overrides };
}

export interface SpawnAgentOpts {
  profile: AgentProfile;
  prompt: string;
  cwd: string;
  routeHint?: BackendName | "auto";
  requiredCapabilities?: BackendCapability[];
  jobId?: string;
  jobName?: string;
  /** Pre-generated session ID. If omitted, one is generated from profile label + timestamp. */
  sessionId?: string;
  /** Tools the agent is not allowed to use (e.g. EnterPlanMode in headless sessions). */
  disallowedTools?: string[];
  /** Extra environment variables to inject. */
  extraEnv?: Record<string, string>;
  onMessage?: (msg: SDKMessage) => void | Promise<void>;
}

export interface AgentResult {
  text: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  timedOut: boolean;
  /** Per-model token usage and cost breakdown from the SDK. */
  modelUsage?: Record<string, ModelUsageStats>;
  /** Per-tool invocation counts (e.g. { Read: 15, Bash: 5, Edit: 3 }). */
  toolCounts?: Record<string, number>;
  /** Number of assistant turns consumed by the /orient skill. Null if orient was not detected. */
  orientTurns?: number;
  /** Set when the session was terminated due to a sleep >30s violation. Contains the violating command. */
  sleepViolation?: string;
  /** Set when the session was terminated due to a pm2 stop/delete command. Contains the violating command. */
  pm2Violation?: string;
  /** Set when the session was terminated due to a shell tool call running >120s. Contains the stalled command. */
  stallViolation?: string;
}

/** Generate a session ID from a profile label. Exported so callers
 *  can pre-generate the ID before building the prompt. */
export function generateSessionId(label: string): string {
  return `${label}-${Date.now().toString(36)}`;
}

// ── Shared utilities ─────────────────────────────────────────────────────────

/** Map tool_use blocks to short human-readable descriptions. */
export function summarizeToolUses(
  blocks: Array<{ type: string; name?: string; input?: Record<string, unknown> }>,
): string[] {
  return blocks
    .filter((b) => b.type === "tool_use")
    .map((t) => {
      const inp = t.input ?? {};
      if (t.name === "Read" || t.name === "Edit" || t.name === "Write") return `${t.name} \`${inp.file_path ?? "?"}\``;
      if (t.name === "Glob") return `Glob \`${inp.pattern ?? "?"}\``;
      if (t.name === "Grep") return `Grep \`${inp.pattern ?? "?"}\``;
      if (t.name === "Bash" || t.name === "Shell" || t.name === "bash") return `${t.name} \`${String(inp.command ?? "").slice(0, 60)}\``;
      return t.name ?? "tool";
    });
}

/** Debounce tool_use_summary events into batches, flushing after a quiet period. */
export function createToolBatchFlusher(
  callback: (summaryLine: string) => Promise<void>,
  debounceMs = 1500,
): { push: (summary: string) => void; flush: () => Promise<void> } {
  let batch: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    timer = null;
    if (batch.length === 0) return;
    const items = batch.splice(0);
    await callback(`:gear: ${items.join(", ")}`);
  };

  return {
    push(summary: string) {
      batch.push(summary);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    flush: async () => {
      if (timer) { clearTimeout(timer); timer = null; }
      await flush();
    },
  };
}

// ── spawnAgent ───────────────────────────────────────────────────────────────

export function spawnAgent(opts: SpawnAgentOpts): {
  sessionId: string;
  handle: SessionHandle;
  result: Promise<AgentResult>;
} {
  if (isDraining()) {
    throw new Error("Cannot spawn agent: scheduler is draining for restart");
  }

  const sessionId = opts.sessionId ?? `${opts.profile.label}-${Date.now().toString(36)}`;
  const backend = resolveBackend({
    model: opts.profile.model,
    requiredCapabilities: opts.requiredCapabilities,
    routeHint: opts.routeHint,
  });

  console.log(`[agent] Spawning [${sessionId}]: runtime=${runtimeRouteForBackend(backend.name)}, model=${opts.profile.model}, maxTurns=${opts.profile.maxTurns ?? "unlimited"}, prompt="${opts.prompt.slice(0, 80)}..."`);

  const queryOpts: BackendQueryOpts = {
    prompt: opts.prompt,
    cwd: opts.cwd,
    model: opts.profile.model,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["project", "user"],
    maxTurns: opts.profile.maxTurns,
    requiredCapabilities: opts.requiredCapabilities,
    disallowedTools: opts.disallowedTools,
    extraEnv: opts.extraEnv,
    onMessage: async (msg) => {
      // Forward to caller's handler
      await opts.onMessage?.(msg);

      // Track turns incrementally so the count is accurate even for backends
      // (like Cursor) that don't report num_turns in their result message.
      if (msg.type === "assistant") {
        incrementSessionTurns(sessionId);
      }

      // L0 sleep guard: check for sleep >30s in Bash tool_use blocks
      if (!sleepViolation) {
        const violation = checkMessageForSleepViolation(msg);
        if (violation) {
          sleepViolation = violation.command;
          console.log(`[agent] SLEEP VIOLATION [${sessionId}]: sleep ${violation.seconds}s detected in command: ${violation.command.slice(0, 100)}`);
          console.log(`[agent] Terminating session [${sessionId}] — "never sleep >30 seconds" (ADR 0017, L0 enforcement)`);
          handle.interrupt().catch(() => {});
        }
      }

      // L0 pm2 guard: check for pm2 stop/delete in Bash tool_use blocks
      if (!pm2Violation) {
        const violation = checkMessageForPm2Violation(msg);
        if (violation) {
          pm2Violation = violation;
          console.log(`[agent] PM2 VIOLATION [${sessionId}]: pm2 stop/delete detected in command: ${violation.slice(0, 100)}`);
          console.log(`[agent] Terminating session [${sessionId}] — pm2 stop/delete would kill the scheduler (L0 enforcement)`);
          handle.interrupt().catch(() => {});
        }
      }

      // L0 stall guard: track shell tool call wall-clock duration.
      // Clear timer on tool_call_completed (tool finished), assistant (next turn), or result (session end).
      // tool_use_summary for non-shell tools does NOT clear the timer — parallel
      // tool calls (e.g. Shell + Read in same turn) would otherwise reset it.
      if (!stallViolation) {
        const shellCmd = extractShellCommands(msg);
        if (shellCmd) {
          stallGuard.onShellToolUse(shellCmd);
        } else if ((msg as { type?: string }).type === "tool_call_completed" ||
                   (msg as { type?: string }).type === "assistant" ||
                   (msg as { type?: string }).type === "result") {
          stallGuard.onActivity();
        }
      }

      // Update session stats from result messages (before buffering, so watch
      // forwarder sees accurate cost/turns when finalizing living messages).
      // numTurns=0 is treated as "not reported" and preserves the incremental count.
      if (msg.type === "result") {
        updateSessionStats(sessionId, msg.total_cost_usd ?? 0, msg.num_turns ?? 0, msg.modelUsage);
      }

      // Buffer summarized messages for session watchers
      const summary = summarizeMessage(msg);
      if (summary) bufferMessage(sessionId, summary);
    },
  };

  const supervised = backend.runSupervised(queryOpts);
  const handle = supervised.handle;

  // Register session for visibility and supervision
  registerSession(sessionId, opts.jobId ?? opts.profile.label, opts.jobName ?? opts.profile.label, handle);

  // Duration timeout
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.log(`[agent] Session [${sessionId}] timed out after ${opts.profile.maxDurationMs}ms, sending interrupt`);
    handle.interrupt().catch(() => {});
  }, opts.profile.maxDurationMs);

  // L0 sleep guard — terminate sessions that attempt sleep >30s (ADR 0017)
  let sleepViolation: string | undefined;
  // L0 pm2 guard — terminate sessions that attempt pm2 stop/delete (ADR 0027)
  let pm2Violation: string | undefined;
  // L0 stall guard — terminate sessions with shell tool calls running >120s
  let stallViolation: string | undefined;
  const stallGuard = new StallGuard({
    onStall: (commands) => {
      stallViolation = commands;
      console.log(`[agent] WALL-CLOCK STALL [${sessionId}]: Shell tool call running >120s: ${commands.slice(0, 200)}`);
      console.log(`[agent] Terminating session [${sessionId}] — wall-clock stall detection (L0 enforcement, ADR 0017)`);
      handle.interrupt().catch(() => {});
    },
  });

  const result = supervised.result
    .then((r): AgentResult => {
      clearTimeout(timer);
      const tracked = getSession(sessionId);
      const trackedTurns = tracked?.numTurns ?? 0;
      const resolvedTurns = (typeof r.numTurns === "number" && r.numTurns > 0) ? r.numTurns : trackedTurns;
      const resolvedCost = (typeof r.costUsd === "number" && r.costUsd > 0) ? r.costUsd : (tracked?.costUsd ?? 0);
      unregisterSession(sessionId);
      console.log(`[agent] Complete [${sessionId}]: ${r.text.length} chars, ${resolvedTurns} turns, ${r.durationMs}ms, $${resolvedCost.toFixed(4)}`);
      stallGuard.dispose();
      return {
        text: r.text,
        costUsd: resolvedCost,
        numTurns: resolvedTurns,
        durationMs: r.durationMs,
        timedOut,
        modelUsage: r.modelUsage,
        toolCounts: r.toolCounts,
        orientTurns: r.orientTurns,
        sleepViolation,
        pm2Violation,
        stallViolation,
      };
    })
    .catch((err): Promise<AgentResult> => {
      clearTimeout(timer);
      stallGuard.dispose();
      unregisterSession(sessionId);
      throw err;
    });

  return { sessionId, handle, result };
}
