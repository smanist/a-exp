/** L0 enforcement: detect long-running shell/bash tool calls that exceed a wall-clock threshold.
 *
 * Addresses the "direct in-process execution" pattern where agents run long-running
 * processes (batch pipelines, training loops) directly instead of using fire-and-forget
 * submission. See postmortem-batch-run-in-process-2026-02-27.md.
 *
 * The sleep guard catches `sleep` commands in tool call text; this guard catches
 * tool calls that actually block for too long during execution, regardless of
 * whether they contain `sleep`.
 */

import { SHELL_TOOL_NAMES } from "./sleep-guard.js";
import type { SDKMessage } from "./sdk.js";

export const STALL_TIMEOUT_MS = 120_000; // 2 minutes

export interface StallGuardOpts {
  timeoutMs?: number;
  onStall: (commands: string) => void;
}

/**
 * Tracks pending shell tool calls and fires a callback if any tool call
 * blocks for longer than the configured timeout.
 *
 * Usage:
 *   1. Call `onShellToolUse(cmd)` when an assistant message contains Shell/Bash tool_use blocks
 *   2. Call `onActivity()` when any subsequent message arrives (tool completed)
 *   3. The `onStall` callback fires if the timeout elapses between steps 1 and 2
 */
export class StallGuard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private triggered = false;
  private readonly timeoutMs: number;
  private readonly onStall: (commands: string) => void;

  constructor(opts: StallGuardOpts) {
    this.timeoutMs = opts.timeoutMs ?? STALL_TIMEOUT_MS;
    this.onStall = opts.onStall;
  }

  onShellToolUse(commands: string): void {
    if (this.triggered) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.triggered = true;
      this.timer = null;
      this.onStall(commands);
    }, this.timeoutMs);
  }

  onActivity(): void {
    this.clearTimer();
  }

  get wasTriggered(): boolean {
    return this.triggered;
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Extract Shell/Bash commands from an SDK message, working across all backends.
 *
 * - Claude SDK: `type: "assistant"` with `tool_use` content blocks named Bash/Shell/bash
 * - Cursor: `type: "tool_use_summary"` with summary like `Shell \`...\``
 * - runtime: `type: "tool_use_summary"` with summary like `bash \`...\``
 *
 * Returns concatenated commands if shell tool calls are found, or null.
 */
export function extractShellCommands(
  msg: SDKMessage,
): string | null {
  if (msg.type === "assistant") {
    const message = msg.message;
    if (!message?.content) return null;

    const shellBlocks = message.content.filter(
      (b) => b.type === "tool_use" && SHELL_TOOL_NAMES.has(b.name ?? ""),
    );
    if (shellBlocks.length === 0) return null;

    return shellBlocks
      .map((b) => {
        const toolBlock = b as { input?: Record<string, unknown> };
        return String(toolBlock.input?.["command"] ?? "?");
      })
      .join("; ");
  }

  if (msg.type === "tool_use_summary") {
    const summary = msg.summary;
    if (!summary) return null;
    const match = summary.match(/^(?:Shell|Bash|bash)\s+`(.*)`$/);
    if (match) return match[1]!;
  }

  return null;
}
