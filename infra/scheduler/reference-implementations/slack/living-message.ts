/** Living Message pattern for Slack: single message per session, updated in-place. */

import type { WebClient } from "@slack/web-api";
import {
  persistLivingMessage,
  unpersistLivingMessage,
  readPersistedLivingMessages,
} from "./living-message-persistence.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface LivingMessage {
  channel: string;
  threadTs: string;
  messageTs: string; // The Slack message ID (ts) to update
  sessionId: string;
  state: "working" | "complete" | "failed";
  turnCount: number;
  maxTurns: number | null;
  startTimeMs: number;
  costUsd: number;
  lastTool: string; // e.g., "Read projects/a-exp/README.md"
  lastActivity: string; // e.g., "reading project files..."
  workSummary: string; // commit summary shown in completion state
}

// ── State ────────────────────────────────────────────────────────────────────

const livingMessages = new Map<string, LivingMessage>();
const pendingUpdates = new Map<string, Partial<LivingMessage>>();
const updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastUpdateTimes = new Map<string, number>();

const MIN_UPDATE_INTERVAL_MS = 3000;

/** Directory for disk persistence. Set via setPersistenceDir(). Null = persistence disabled. */
let persistenceDir: string | null = null;

/** Set the base directory for living message disk persistence. */
export function setPersistenceDir(dir: string | null): void {
  persistenceDir = dir;
}

/** Get the current persistence directory (for startup recovery). */
export function getPersistenceDir(): string | null {
  return persistenceDir;
}

/** Reset all in-memory state. For tests only. */
export function _resetForTesting(): void {
  livingMessages.clear();
  pendingUpdates.clear();
  for (const timer of updateTimers.values()) clearTimeout(timer);
  updateTimers.clear();
  lastUpdateTimes.clear();
}

// ── Public API ───────────────────────────────────────────────────────────────

interface CreateLivingMessageOpts {
  client: WebClient;
  channel: string;
  threadTs: string;
  sessionId: string;
  maxTurns?: number | null;
}

/** Create the initial living message. Returns the LivingMessage object. */
export async function createLivingMessage(
  opts: CreateLivingMessageOpts,
): Promise<LivingMessage> {
  const key = `${opts.channel}:${opts.threadTs}`;

  const lm: LivingMessage = {
    channel: opts.channel,
    threadTs: opts.threadTs,
    messageTs: "", // will be set after posting
    sessionId: opts.sessionId,
    state: "working",
    turnCount: 0,
    maxTurns: opts.maxTurns ?? null,
    startTimeMs: Date.now(),
    costUsd: 0,
    lastTool: "",
    lastActivity: "starting...",
    workSummary: "",
  };

  const text = formatLivingMessage(lm);

  try {
    const result = await opts.client.chat.postMessage({
      channel: opts.channel,
      thread_ts: opts.threadTs,
      text,
    });

    if (result.ok && result.ts) {
      lm.messageTs = result.ts;
      livingMessages.set(key, lm);

      // Persist to disk so finalization survives process restarts
      if (persistenceDir) {
        try {
          await persistLivingMessage({
            channel: lm.channel,
            threadTs: lm.threadTs,
            messageTs: lm.messageTs,
            sessionId: lm.sessionId,
            startTimeMs: lm.startTimeMs,
          }, persistenceDir);
        } catch (err) {
          console.error(`[living-message] Failed to persist to disk:`, err);
        }
      }

      console.log(`[living-message] Created for session ${opts.sessionId} (${key})`);
      return lm;
    } else {
      throw new Error(`Failed to create living message: ${result.error ?? "unknown error"}`);
    }
  } catch (err) {
    console.error(`[living-message] Failed to create message:`, err);
    throw err;
  }
}

/** Schedule an update to the living message. Updates are coalesced to respect rate limits. */
export function scheduleLivingMessageUpdate(
  client: WebClient,
  sessionId: string,
  patch: Partial<LivingMessage>,
): void {
  const lm = findLivingMessage(sessionId);
  if (!lm) {
    console.warn(`[living-message] No living message found for session ${sessionId}`);
    return;
  }

  const key = `${lm.channel}:${lm.threadTs}`;

  // Merge the patch into pending updates
  const pending = pendingUpdates.get(key) ?? {};
  Object.assign(pending, patch);
  pendingUpdates.set(key, pending);

  // Schedule the flush
  const lastUpdate = lastUpdateTimes.get(key) ?? 0;
  const elapsed = Date.now() - lastUpdate;

  if (elapsed >= MIN_UPDATE_INTERVAL_MS) {
    // Flush immediately
    flushUpdate(client, lm, key);
  } else {
    // Schedule a flush after the remaining interval
    if (!updateTimers.has(key)) {
      const timer = setTimeout(() => {
        updateTimers.delete(key);
        flushUpdate(client, lm, key);
      }, MIN_UPDATE_INTERVAL_MS - elapsed);
      updateTimers.set(key, timer);
    }
  }
}

/** Finalize the living message (transition to complete/failed state). Always flushes immediately.
 *  If the in-memory record is missing (e.g., after a process restart), falls back to disk
 *  persistence and posts a new completion message to the thread. */
export async function finalizeLivingMessage(
  client: WebClient,
  sessionId: string,
  opts: {
    state: "complete" | "failed";
    costUsd?: number;
    turnCount?: number;
    error?: string;
    workSummary?: string;
  },
): Promise<void> {
  const lm = findLivingMessage(sessionId);

  if (!lm) {
    // Fall back to disk persistence — the record may have survived a restart
    await finalizeLivingMessageFromDisk(client, sessionId, opts);
    return;
  }

  const key = `${lm.channel}:${lm.threadTs}`;

  // Cancel any pending timer
  const timer = updateTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    updateTimers.delete(key);
  }

  // Apply final updates
  lm.state = opts.state;
  if (opts.costUsd !== undefined) lm.costUsd = opts.costUsd;
  if (opts.turnCount !== undefined) lm.turnCount = opts.turnCount;
  if (opts.error) lm.lastActivity = opts.error;
  if (opts.workSummary) lm.workSummary = opts.workSummary;

  const text = formatLivingMessage(lm);

  try {
    await client.chat.update({
      channel: lm.channel,
      ts: lm.messageTs,
      text,
    });
    console.log(`[living-message] Finalized session ${sessionId} as ${opts.state}`);
  } catch (err) {
    console.error(`[living-message] Failed to finalize message:`, err);
  }

  // Clean up in-memory state
  livingMessages.delete(key);
  pendingUpdates.delete(key);
  lastUpdateTimes.delete(key);

  // Clean up disk record
  if (persistenceDir) {
    unpersistLivingMessage(sessionId, persistenceDir).catch((err) => {
      console.error(`[living-message] Failed to clean up disk record:`, err);
    });
  }
}

/** Fallback finalization: read from disk and post a new message (can't update the original). */
async function finalizeLivingMessageFromDisk(
  client: WebClient,
  sessionId: string,
  opts: {
    state: "complete" | "failed";
    costUsd?: number;
    turnCount?: number;
    error?: string;
    workSummary?: string;
  },
): Promise<void> {
  if (!persistenceDir) {
    console.warn(`[living-message] No living message found for session ${sessionId} to finalize (no persistence dir)`);
    return;
  }

  let persisted;
  try {
    const all = await readPersistedLivingMessages(persistenceDir);
    persisted = all.find((m) => m.sessionId === sessionId);
  } catch (err) {
    console.error(`[living-message] Failed to read persisted living messages:`, err);
    return;
  }

  if (!persisted) {
    console.warn(`[living-message] No living message found for session ${sessionId} (in-memory or disk)`);
    return;
  }

  // Build a synthetic LivingMessage to format the completion text
  const lm: LivingMessage = {
    channel: persisted.channel,
    threadTs: persisted.threadTs,
    messageTs: persisted.messageTs,
    sessionId,
    state: opts.state,
    turnCount: opts.turnCount ?? 0,
    maxTurns: null,
    startTimeMs: persisted.startTimeMs,
    costUsd: opts.costUsd ?? 0,
    lastTool: "",
    lastActivity: opts.error ?? "",
    workSummary: opts.workSummary ?? "",
  };

  const text = formatLivingMessage(lm);

  // Post a new message (can't reliably update the original after a restart)
  try {
    await client.chat.postMessage({
      channel: persisted.channel,
      thread_ts: persisted.threadTs,
      text,
    });
    console.log(`[living-message] Finalized session ${sessionId} as ${opts.state} (from disk fallback)`);
  } catch (err) {
    console.error(`[living-message] Failed to post fallback finalization:`, err);
  }

  // Clean up disk record
  unpersistLivingMessage(sessionId, persistenceDir).catch((err) => {
    console.error(`[living-message] Failed to clean up disk record:`, err);
  });
}

/** Get the living message for a session, if it exists. */
export function findLivingMessage(sessionId: string): LivingMessage | undefined {
  for (const lm of livingMessages.values()) {
    if (lm.sessionId === sessionId) return lm;
  }
  return undefined;
}

/** Check if living messages feature is enabled. */
export function isLivingMessageEnabled(): boolean {
  // Default to enabled. Set SLACK_LIVING_MESSAGE=0 to disable.
  return process.env.SLACK_LIVING_MESSAGE !== "0";
}

/** Count active living messages (sessions in progress). */
export function countActiveLivingMessages(): number {
  return livingMessages.size;
}

/** Get all living message session IDs (for orphan detection). */
export function getLivingMessageSessionIds(): string[] {
  return Array.from(livingMessages.values()).map((lm) => lm.sessionId);
}

/** Remove an orphaned living message (no corresponding active session). */
export function removeOrphanedLivingMessage(sessionId: string): boolean {
  for (const [key, lm] of livingMessages.entries()) {
    if (lm.sessionId === sessionId) {
      livingMessages.delete(key);
      pendingUpdates.delete(key);
      updateTimers.delete(key);
      lastUpdateTimes.delete(key);
      console.log(`[living-message] Cleaned up orphaned living message for session ${sessionId}`);
      return true;
    }
  }
  return false;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function flushUpdate(client: WebClient, lm: LivingMessage, key: string): void {
  const pending = pendingUpdates.get(key);
  if (!pending) return;

  // Apply pending updates to the living message
  Object.assign(lm, pending);
  pendingUpdates.delete(key);

  const text = formatLivingMessage(lm);

  client.chat.update({
    channel: lm.channel,
    ts: lm.messageTs,
    text,
  }).then(() => {
    lastUpdateTimes.set(key, Date.now());
  }).catch((err) => {
    console.error(`[living-message] Failed to update message:`, err);
    // Graceful degradation: if update fails, fall back to postMessage
    client.chat.postMessage({
      channel: lm.channel,
      thread_ts: lm.threadTs,
      text,
    }).catch((fallbackErr) => {
      console.error(`[living-message] Fallback postMessage also failed:`, fallbackErr);
    });
  });
}

function formatLivingMessage(lm: LivingMessage): string {
  const elapsedSec = Math.floor((Date.now() - lm.startTimeMs) / 1000);
  const elapsed = formatDuration(elapsedSec);

  if (lm.state === "working") {
    const emoji = ":bulb:";
    const maxTurnsStr = lm.maxTurns ? `/${lm.maxTurns}` : "";
    // Truncate lastActivity for display — it can now contain actual agent content
    const activityDisplay = lm.lastActivity.length > 140
      ? lm.lastActivity.slice(0, 140) + "..."
      : lm.lastActivity;
    const status = `${emoji} *Working* — ${activityDisplay}`;
    const meta = `Turn ${lm.turnCount}${maxTurnsStr} · ${elapsed} · $${lm.costUsd.toFixed(2)}`;
    return `${status}\n${meta}`;
  }

  if (lm.state === "complete") {
    const emoji = ":white_check_mark:";
    const headline = `${emoji} *Complete* — ${elapsed} · ${lm.turnCount} turns · $${lm.costUsd.toFixed(2)}`;
    if (lm.workSummary) {
      return `${headline}\n${lm.workSummary}`;
    }
    return headline;
  }

  if (lm.state === "failed") {
    const emoji = ":x:";
    const errorMsg = lm.lastActivity || "unknown error";
    return `${emoji} *Failed* — ${elapsed} · ${lm.turnCount} turns · $${lm.costUsd.toFixed(2)}\nError: ${errorMsg}`;
  }

  return `[unknown state: ${lm.state}]`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return `${hr}h ${m}m`;
}
