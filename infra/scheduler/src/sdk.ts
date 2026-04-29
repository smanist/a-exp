/** Transport-neutral query/message types and lightweight helpers shared across runtimes. */

export interface SDKTextBlock {
  type: "text";
  text: string;
}

export interface SDKToolUseBlock {
  type: "tool_use";
  name: string;
  input?: Record<string, unknown>;
}

export interface SDKUnknownBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

export type SDKContentBlock = SDKTextBlock | SDKToolUseBlock | SDKUnknownBlock;

export interface SDKAssistantMessage {
  type: "assistant";
  message?: {
    role?: string;
    content?: SDKContentBlock[];
  };
}

export interface SDKSystemMessage {
  type: "system";
  subtype?: string;
  session_id?: string;
}

export interface SDKResultMessage {
  type: "result";
  subtype?: string;
  duration_ms?: number;
  is_error?: boolean;
  result?: string;
  output_text?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  modelUsage?: Record<string, ModelUsageStats>;
}

export interface SDKToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
}

export interface SDKToolCallCompletedMessage {
  type: "tool_call_completed";
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKSystemMessage
  | SDKResultMessage
  | SDKToolUseSummaryMessage
  | SDKToolCallCompletedMessage;

export interface QueryOpts {
  prompt: string;
  cwd: string;
  model?: string;
  systemPrompt?: unknown;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  tools?: unknown;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  settingSources?: string[];
  agents?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  extraEnv?: Record<string, string>;
  onMessage?: (msg: SDKMessage) => void | Promise<void>;
}

export interface ModelUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  uncachedInputTokens?: number;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  lastCacheReadInputTokens?: number;
  lastTotalTokens?: number;
}

export interface QueryResult {
  text: string;
  ok: boolean;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  durationMs: number;
  modelUsage?: Record<string, ModelUsageStats>;
  toolCounts?: Record<string, number>;
  orientTurns?: number;
}

/** Tools that signal the execution phase has started (post-orient). */
const EXECUTION_PHASE_TOOLS = new Set(["Edit", "Write", "TodoWrite"]);

/** Tracks orient turn count from a stream of tool_use events. */
export class OrientTurnTracker {
  private assistantTurnCount = 0;
  private orientStartTurn: number | null = null;
  private _orientTurns: number | undefined;

  onNewTurn(): void {
    this.assistantTurnCount++;
  }

  onTool(name: string, input?: Record<string, unknown>): void {
    if (name === "Skill" && this.orientStartTurn === null) {
      if (input && typeof input.skill === "string" && input.skill.includes("orient")) {
        this.orientStartTurn = this.assistantTurnCount;
      }
    }
    if (EXECUTION_PHASE_TOOLS.has(name) && this.orientStartTurn !== null && this._orientTurns === undefined) {
      this._orientTurns = this.assistantTurnCount - this.orientStartTurn;
    }
  }

  finalize(): void {
    if (this.orientStartTurn !== null && this._orientTurns === undefined) {
      this._orientTurns = this.assistantTurnCount - this.orientStartTurn;
    }
  }

  get orientTurns(): number | undefined {
    return this._orientTurns;
  }
}

/** Run a one-shot query through the model-driven runtime resolver. */
export async function runQuery(opts: QueryOpts): Promise<QueryResult> {
  const { resolveBackend } = await import("./backend.js");
  const backend = resolveBackend({
    model: opts.model,
  });
  return backend.runQuery({
    ...opts,
  });
}
