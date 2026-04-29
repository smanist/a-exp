/** L0 enforcement: detect and block sleep commands exceeding the 30-second limit (ADR 0017). */

import type { SDKMessage } from "./sdk.js";

const MAX_SLEEP_SECONDS = 30;

/** Tool names that execute shell commands across different backends. */
export const SHELL_TOOL_NAMES = new Set(["Bash", "Shell", "bash"]);

/**
 * Extract sleep duration from a bash command string.
 * Returns the duration in seconds if a `sleep` command with duration > MAX_SLEEP_SECONDS
 * is detected, or null if no violation found.
 *
 * Handles patterns like:
 *   sleep 120
 *   sleep 120 && ...
 *   sleep 60s
 *   sleep 2m
 *   sleep 1h
 *   ... ; sleep 120 ; ...
 *   ... && sleep 120 && ...
 */
export function detectSleepViolation(command: string): number | null {
  // Match `sleep` followed by a numeric duration with optional suffix
  // Supports: sleep 120, sleep 60s, sleep 2m, sleep 1.5h, sleep 0.5m
  const pattern = /\bsleep\s+([\d.]+)([smh]?)\b/gi;
  let match;

  while ((match = pattern.exec(command)) !== null) {
    const value = parseFloat(match[1]!);
    if (isNaN(value)) continue;

    const suffix = (match[2] ?? "").toLowerCase();
    let seconds: number;
    switch (suffix) {
      case "m":
        seconds = value * 60;
        break;
      case "h":
        seconds = value * 3600;
        break;
      case "s":
      case "":
        seconds = value;
        break;
      default:
        seconds = value;
    }

    if (seconds > MAX_SLEEP_SECONDS) {
      return seconds;
    }
  }

  return null;
}

/**
 * Check an SDK message for Bash tool_use blocks containing sleep violations.
 * Returns the violating command and duration, or null if no violation.
 */
export function checkMessageForSleepViolation(
  msg: SDKMessage,
): { command: string; seconds: number } | null {
  // Codex-style summaries (and Codex CLI mapped summaries).
  if (msg.type === "tool_use_summary" && typeof msg.summary === "string") {
    const match = msg.summary.match(/^(?:Shell|Bash|bash)\s+`(.*)`$/);
    if (match) {
      const command = match[1]!;
      const seconds = detectSleepViolation(command);
      if (seconds !== null) return { command, seconds };
    }
    return null;
  }

  if (msg.type !== "assistant" || !msg.message?.content) return null;

  for (const block of msg.message.content) {
    if (block.type !== "tool_use" || !SHELL_TOOL_NAMES.has(block.name ?? "")) continue;
    const command = block.input?.["command"];
    if (typeof command !== "string") continue;

    const seconds = detectSleepViolation(command);
    if (seconds !== null) {
      return { command, seconds };
    }
  }

  return null;
}
