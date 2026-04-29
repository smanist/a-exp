/** Per-thread response mode tracking.
 *  Each thread can be 'active' (respond to all messages) or 'mention' (respond only to @mentions).
 *  Default is 'mention'. Keyed by convKey (channel:threadTs). */

export type ThreadMode = "active" | "mention";

const threadModes = new Map<string, ThreadMode>();

/** Get the response mode for a thread. Returns 'mention' (default) if not explicitly set. */
export function getThreadMode(convKey: string): ThreadMode {
  return threadModes.get(convKey) ?? "mention";
}

/** Set the response mode for a thread.
 *  Setting to 'mention' (the default) removes the entry to keep the map lean. */
export function setThreadMode(convKey: string, mode: ThreadMode): void {
  if (mode === "mention") {
    threadModes.delete(convKey);
  } else {
    threadModes.set(convKey, mode);
  }
}

/** Check whether a thread is in active mode (respond to all messages). */
export function isThreadActive(convKey: string): boolean {
  return getThreadMode(convKey) === "active";
}

/** Parse an in-thread toggle command. Returns the target mode, or null if not a toggle command.
 *  Recognized commands: "active on", "active off". */
export function parseThreadModeCommand(text: string): ThreadMode | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === "active on") return "active";
  if (normalized === "active off") return "mention";
  return null;
}

/** Reset all state — for testing only. */
export function clearAllThreadModes(): void {
  threadModes.clear();
}
