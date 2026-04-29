/** Disk-based persistence for living message metadata. Survives pm2 restarts.
 *  Records are written when a living message is created and removed on finalization.
 *  On startup, stale files indicate sessions interrupted by a restart. */

import { mkdir, writeFile, readFile, readdir, unlink, rm } from "node:fs/promises";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PersistedLivingMessage {
  channel: string;
  threadTs: string;
  messageTs: string;
  sessionId: string;
  startTimeMs: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function messagesDir(baseDir: string): string {
  return join(baseDir, "living-messages");
}

function messagePath(baseDir: string, sessionId: string): string {
  return join(messagesDir(baseDir), `${sessionId}.json`);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Write living message metadata to disk. Creates the directory if needed. */
export async function persistLivingMessage(
  msg: PersistedLivingMessage,
  baseDir: string,
): Promise<void> {
  const dir = messagesDir(baseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(messagePath(baseDir, msg.sessionId), JSON.stringify(msg));
}

/** Remove a living message file after finalization. Idempotent. */
export async function unpersistLivingMessage(
  sessionId: string,
  baseDir: string,
): Promise<void> {
  try {
    await unlink(messagePath(baseDir, sessionId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Read all persisted living message files. Skips malformed JSON. */
export async function readPersistedLivingMessages(
  baseDir: string,
): Promise<PersistedLivingMessage[]> {
  const dir = messagesDir(baseDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const messages: PersistedLivingMessage[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, entry), "utf-8");
      messages.push(JSON.parse(raw) as PersistedLivingMessage);
    } catch {
      console.warn(`[living-message-persistence] Skipping malformed file: ${entry}`);
    }
  }
  return messages;
}

/** Remove all persisted living message files. */
export async function clearPersistedLivingMessages(
  baseDir: string,
): Promise<void> {
  const dir = messagesDir(baseDir);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }
}
