/** Disk-based persistence for active deep work sessions. Survives pm2 restarts.
 *  Session metadata is written before spawning and removed on normal completion.
 *  On startup, stale files indicate sessions interrupted by a restart. */

import { mkdir, writeFile, readFile, readdir, unlink, rm } from "node:fs/promises";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PersistedSession {
  sessionId: string;
  task: string;
  /** Slack thread key: "channel:threadTs" */
  threadKey: string;
  startedAtMs: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sessionsDir(baseDir: string): string {
  return join(baseDir, "active-sessions");
}

function sessionPath(baseDir: string, sessionId: string): string {
  return join(sessionsDir(baseDir), `${sessionId}.json`);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Write session metadata to disk. Creates the directory if needed. */
export async function persistSession(
  session: PersistedSession,
  baseDir: string,
): Promise<void> {
  const dir = sessionsDir(baseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionPath(baseDir, session.sessionId), JSON.stringify(session));
}

/** Remove a session file after normal completion. Idempotent. */
export async function unpersistSession(
  sessionId: string,
  baseDir: string,
): Promise<void> {
  try {
    await unlink(sessionPath(baseDir, sessionId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Read all persisted session files. Skips malformed JSON. */
export async function readPersistedSessions(
  baseDir: string,
): Promise<PersistedSession[]> {
  const dir = sessionsDir(baseDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const sessions: PersistedSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, entry), "utf-8");
      sessions.push(JSON.parse(raw) as PersistedSession);
    } catch {
      console.warn(`[session-persistence] Skipping malformed file: ${entry}`);
    }
  }
  return sessions;
}

/** Remove all persisted session files. */
export async function clearPersistedSessions(
  baseDir: string,
): Promise<void> {
  const dir = sessionsDir(baseDir);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }
}
