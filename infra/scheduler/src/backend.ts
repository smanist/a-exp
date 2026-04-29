/** Runtime adapter abstraction. Public configuration is model-driven; runtime routing remains internal. */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { QueryOpts, QueryResult, SDKMessage, ModelUsageStats } from "./sdk.js";
import { computeEffectiveModel, DEFAULT_MODEL_BY_TIER } from "./model-tiers.js";

export type BackendCapability =
  | "interactive_input"
  | "session_interrupt"
  | "subagents"
  | "native_system_prompt";

export type BackendName = "codex" | "openai";
export type RuntimeHint = BackendName | "auto";

export interface ResolveBackendOpts {
  model?: string;
  requiredCapabilities?: BackendCapability[];
  routeHint?: RuntimeHint;
}

export interface UserInputMessage {
  content: string;
  sessionId?: string;
}

export interface SessionHandle {
  interrupt(): Promise<void>;
  streamInput?(input: AsyncIterable<UserInputMessage>): Promise<void>;
  readonly backend: BackendName;
  readonly capabilities: ReadonlySet<BackendCapability>;
  supportsCapability(capability: BackendCapability): boolean;
}

export interface BackendQueryOpts extends QueryOpts {
  systemPromptText?: string;
  requiredCapabilities?: BackendCapability[];
}

export interface SupervisedResult {
  handle: SessionHandle;
  result: Promise<QueryResult>;
}

export interface AgentBackend {
  readonly name: BackendName;
  readonly capabilities: ReadonlySet<BackendCapability>;
  runQuery(opts: BackendQueryOpts): Promise<QueryResult>;
  runSupervised(opts: BackendQueryOpts): SupervisedResult;
}

function capabilitySet(...caps: BackendCapability[]): ReadonlySet<BackendCapability> {
  return new Set(caps);
}

function makeHandle(
  backend: BackendName,
  capabilities: ReadonlySet<BackendCapability>,
  interrupt: () => Promise<void>,
  streamInput?: (input: AsyncIterable<UserInputMessage>) => Promise<void>,
): SessionHandle {
  return {
    backend,
    capabilities,
    interrupt,
    streamInput,
    supportsCapability(capability: BackendCapability) {
      return capabilities.has(capability);
    },
  };
}

async function materializeUserInput(input: AsyncIterable<UserInputMessage>): Promise<UserInputMessage | null> {
  const chunks: string[] = [];
  let sessionId: string | undefined;
  for await (const item of input) {
    if (!item) continue;
    if (item.sessionId) sessionId = item.sessionId;
    if (item.content) chunks.push(item.content);
  }
  const content = chunks.join("\n").trim();
  if (!content) return null;
  return { content, sessionId };
}

export const CODEX_DEFAULT_MODEL = DEFAULT_MODEL_BY_TIER.strong;

export function resolveModelForBackend(
  backendName: BackendName,
  model?: string,
): string {
  return computeEffectiveModel(model);
}

export function parseCodexMessage(line: string): SDKMessage | null {
  try {
    const msg = JSON.parse(line);
    return parseCodexMessageObject(msg);
  } catch {
    return null;
  }
}

function parseCodexMessageObject(msg: unknown): SDKMessage | null {
  try {
    if (!msg || typeof msg !== "object") return null;
    const parsed = msg as Record<string, unknown>;
    const type = parsed.type;

    if (type === "thread.started" && (parsed.thread_id || parsed.threadId || parsed.session_id || parsed.sessionId)) {
      return {
        type: "system",
        subtype: "init",
        session_id: String(parsed.thread_id ?? parsed.threadId ?? parsed.session_id ?? parsed.sessionId),
      };
    }

    const item = parsed.item as Record<string, unknown> | undefined;
    if (type === "item.completed" && item?.type === "agent_message" && typeof item?.text === "string") {
      return {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: item.text as string }] },
      };
    }

    if (type === "item.started" && item?.type === "command_execution" && typeof item?.command === "string") {
      const cmd = item.command as string;
      return { type: "tool_use_summary", summary: `Shell \`${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}\`` };
    }

    if (type === "item.completed" && item?.type === "command_execution") {
      return { type: "tool_call_completed" };
    }

    const message = parsed.message as { role?: unknown; content?: unknown } | undefined;
    if (type === "assistant" && Array.isArray(message?.content)) {
      return {
        type: "assistant",
        message: {
          role: typeof message.role === "string" ? message.role : undefined,
          content: message.content as Array<Record<string, unknown>>,
        },
      };
    }

    if (type === "system" && parsed.subtype === "init") {
      return {
        type: "system",
        subtype: "init",
        session_id: String(parsed.session_id ?? parsed.sessionId ?? parsed.id ?? ""),
      };
    }

    if (type === "result") {
      return {
        type: "result",
        subtype: typeof parsed.subtype === "string" ? parsed.subtype : "success",
        duration_ms: typeof parsed.duration_ms === "number" ? parsed.duration_ms : Number(parsed.durationMs ?? 0),
        is_error: parsed.is_error === true,
        result: typeof parsed.result === "string" ? parsed.result : String(parsed.output_text ?? ""),
        session_id: String(parsed.session_id ?? parsed.sessionId ?? parsed.id ?? ""),
        total_cost_usd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
        num_turns: typeof parsed.num_turns === "number" ? parsed.num_turns : 0,
      };
    }

    if (type === "tool_use" || type === "tool_call") {
      const tool = parsed.tool as Record<string, unknown> | undefined;
      const part = parsed.part as Record<string, unknown> | undefined;
      const partState = (part?.state as Record<string, unknown> | undefined)?.input as Record<string, unknown> | undefined;
      const toolName = String(parsed.name ?? parsed.tool_name ?? tool?.name ?? part?.tool ?? "tool");
      const input = (parsed.input ?? parsed.args ?? partState ?? {}) as Record<string, unknown>;
      let detail = "";
      if (input.command) detail = ` ${String(input.command)}`;
      else if (input.file_path) detail = ` ${String(input.file_path)}`;
      else if (input.path) detail = ` ${String(input.path)}`;
      else if (input.pattern) detail = ` ${String(input.pattern)}`;
      return { type: "tool_use_summary", summary: `${toolName}${detail}` };
    }

    if (type === "tool_call_completed" || (type === "tool_call" && parsed.subtype === "completed")) {
      return { type: "tool_call_completed" };
    }

    return null;
  } catch {
    return null;
  }
}

export type CodexExecJsonState = {
  sessionId?: string;
  assistantText: string;
  assistantMessageCount: number;
  turnStartedCount: number;
  turnCompletedCount: number;
  reportedTurns?: number;
  reportedText?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadInputTokens: number;
  toolFallbackText: string;
  toolFallbackCommandCount: number;
  toolFallbackTruncated: boolean;
  isError: boolean;
};

const CODEX_TOOL_FALLBACK_MAX_CHARS = 20_000;
const CODEX_TOOL_FALLBACK_MAX_COMMANDS = 25;

export function createCodexExecJsonState(): CodexExecJsonState {
  return {
    assistantText: "",
    assistantMessageCount: 0,
    turnStartedCount: 0,
    turnCompletedCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    lastCacheReadInputTokens: 0,
    toolFallbackText: "",
    toolFallbackCommandCount: 0,
    toolFallbackTruncated: false,
    isError: false,
  };
}

export function consumeCodexExecJsonMessage(state: CodexExecJsonState, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Record<string, unknown>;
  const type = msg.type;
  if (type === "thread.started") {
    const threadId = msg.thread_id ?? msg.threadId ?? msg.session_id ?? msg.sessionId;
    if (typeof threadId === "string" && threadId) state.sessionId = threadId;
    return;
  }
  if (type === "turn.started") {
    state.turnStartedCount += 1;
    return;
  }
  if (type === "turn.completed") {
    state.turnCompletedCount += 1;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      const inputTokens = usage.input_tokens ?? usage.inputTokens;
      const outputTokens = usage.output_tokens ?? usage.outputTokens;
      const cachedInputTokens = usage.cached_input_tokens ?? usage.cacheReadInputTokens;
      if (typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens > 0) {
        state.inputTokens += inputTokens;
        state.lastInputTokens = inputTokens;
      } else {
        state.lastInputTokens = 0;
      }
      if (typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0) {
        state.outputTokens += outputTokens;
        state.lastOutputTokens = outputTokens;
      } else {
        state.lastOutputTokens = 0;
      }
      if (typeof cachedInputTokens === "number" && Number.isFinite(cachedInputTokens) && cachedInputTokens > 0) {
        state.cacheReadInputTokens += cachedInputTokens;
        state.lastCacheReadInputTokens = cachedInputTokens;
      } else {
        state.lastCacheReadInputTokens = 0;
      }
    }
    return;
  }
  if (type === "item.completed") {
    const item = msg.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") return;
    if (item.type === "agent_message" && typeof item.text === "string") {
      state.assistantMessageCount += 1;
      const text = item.text.trimEnd();
      if (text) {
        if (state.assistantText) state.assistantText += "\n";
        state.assistantText += text;
      }
      return;
    }
    if (item.type === "command_execution") {
      if (state.toolFallbackTruncated) return;
      if (state.toolFallbackCommandCount >= CODEX_TOOL_FALLBACK_MAX_COMMANDS) {
        state.toolFallbackTruncated = true;
        state.toolFallbackText += "\n\n[tool output truncated: too many commands]";
        return;
      }

      const command = typeof item.command === "string" ? item.command : "";
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;

      const header = command ? `$ ${command}` : "$ <command>";
      const body = output.trimEnd();
      const suffix = exitCode != null && exitCode !== 0 && !body ? `\n(exit_code: ${exitCode})` : "";
      let chunk = header;
      if (body) chunk += `\n${body}`;
      if (suffix) chunk += suffix;

      if (chunk.trim()) {
        if (state.toolFallbackText) state.toolFallbackText += "\n\n";
        state.toolFallbackText += chunk;
        state.toolFallbackCommandCount += 1;
      }

      if (state.toolFallbackText.length > CODEX_TOOL_FALLBACK_MAX_CHARS) {
        state.toolFallbackTruncated = true;
        state.toolFallbackText = state.toolFallbackText.slice(0, CODEX_TOOL_FALLBACK_MAX_CHARS) +
          "\n\n[tool output truncated]";
      }
    }
  }
  if (type === "result") {
    if (typeof msg.result === "string" && msg.result) state.reportedText = msg.result;
    if (typeof msg.output_text === "string" && msg.output_text) state.reportedText = msg.output_text;
    if (msg.is_error === true) state.isError = true;
    if (typeof msg.session_id === "string" && msg.session_id) state.sessionId = msg.session_id;
    if (typeof msg.sessionId === "string" && msg.sessionId) state.sessionId = msg.sessionId;
    if (typeof msg.num_turns === "number" && msg.num_turns > 0) state.reportedTurns = msg.num_turns;
  }
}

export function finalizeCodexExecJsonState(state: CodexExecJsonState): {
  text: string;
  numTurns: number;
  sessionId?: string;
  ok: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    uncachedInputTokens: number;
    lastInputTokens: number;
    lastOutputTokens: number;
    lastCacheReadInputTokens: number;
    lastTotalTokens: number;
  };
} {
  const text = (state.reportedText ?? state.assistantText).trim();
  const finalText = text || state.toolFallbackText.trim();
  const numTurns = state.reportedTurns && state.reportedTurns > 0
    ? state.reportedTurns
    : (state.turnCompletedCount || state.turnStartedCount || state.assistantMessageCount);
  const usage = (state.inputTokens > 0 || state.outputTokens > 0 || state.cacheReadInputTokens > 0)
    ? {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        cacheReadInputTokens: state.cacheReadInputTokens,
        uncachedInputTokens: Math.max(0, state.inputTokens - state.cacheReadInputTokens),
        lastInputTokens: state.lastInputTokens,
        lastOutputTokens: state.lastOutputTokens,
        lastCacheReadInputTokens: state.lastCacheReadInputTokens,
        lastTotalTokens: state.lastInputTokens + state.lastOutputTokens,
      }
    : undefined;
  return { text: finalText, numTurns, sessionId: state.sessionId, ok: !state.isError, usage };
}

abstract class BaseCodexBackend implements AgentBackend {
  abstract readonly name: "codex" | "openai";
  abstract readonly capabilities: ReadonlySet<BackendCapability>;

  protected buildPrompt(opts: BackendQueryOpts): string {
    if (opts.systemPromptText) {
      return `<system_instructions>\n${opts.systemPromptText}\n</system_instructions>\n\n${opts.prompt}`;
    }
    return opts.prompt;
  }

  protected buildExecArgs(opts: BackendQueryOpts): string[] {
    const prompt = this.buildPrompt(opts);
    const model = resolveModelForBackend(this.name, opts.model);
    return [
      "exec",
      "--json",
      "-C", opts.cwd,
      "--dangerously-bypass-approvals-and-sandbox",
      "-m", model,
      prompt,
    ];
  }

  protected buildResumeArgs(sessionId: string, prompt: string, opts: BackendQueryOpts): string[] {
    const model = resolveModelForBackend(this.name, opts.model);
    return [
      "exec",
      "resume",
      "--json",
      "-C", opts.cwd,
      "--dangerously-bypass-approvals-and-sandbox",
      "-m", model,
      sessionId,
      prompt,
    ];
  }

  protected spawnCodex(
    args: string[],
    opts: BackendQueryOpts,
    onMessage?: (msg: SDKMessage) => void | Promise<void>,
  ): { proc: ChildProcess; result: Promise<QueryResult>; getSessionId: () => string | undefined } {
    const start = Date.now();
    const cwd = opts.cwd;
    const codexBin = process.env["CODEX_BIN"] || "codex";
    const resolvedModel = resolveModelForBackend(this.name, opts.model);
    const proc = spawn(codexBin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.extraEnv ?? {}) },
    });

    const streamState = createCodexExecJsonState();

    const result = new Promise<QueryResult>((resolve, reject) => {
      let stderr = "";

      if (proc.stdout) {
        const rl = createInterface({ input: proc.stdout });
        rl.on("line", async (line) => {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            return;
          }

          consumeCodexExecJsonMessage(streamState, raw);
          if ((raw as { type?: unknown }).type === "turn.completed") {
            const finalized = finalizeCodexExecJsonState(streamState);
            if (finalized.usage) {
              const usageStats: ModelUsageStats = {
                inputTokens: finalized.usage.inputTokens,
                outputTokens: finalized.usage.outputTokens,
                cacheReadInputTokens: finalized.usage.cacheReadInputTokens,
                cacheCreationInputTokens: 0,
                costUSD: 0,
                uncachedInputTokens: finalized.usage.uncachedInputTokens,
                lastInputTokens: finalized.usage.lastInputTokens,
                lastOutputTokens: finalized.usage.lastOutputTokens,
                lastCacheReadInputTokens: finalized.usage.lastCacheReadInputTokens,
                lastTotalTokens: finalized.usage.lastTotalTokens,
              };
              const usageMsg: SDKMessage = {
                type: "result",
                subtype: "progress",
                is_error: false,
                result: "",
                session_id: finalized.sessionId ?? "",
                total_cost_usd: 0,
                num_turns: finalized.numTurns,
                modelUsage: {
                  [resolvedModel]: usageStats,
                },
              };
              if (onMessage) {
                try { await onMessage(usageMsg); } catch { /* best effort */ }
              }
            }
          }
          const msg = parseCodexMessageObject(raw);
          if (!msg) return;
          if (onMessage) {
            try { await onMessage(msg); } catch { /* best effort */ }
          }
        });
      }

      if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      proc.on("error", (err) => reject(new Error(`${this.name} failed to start: ${err.message}`)));
      proc.on("close", (code) => {
        const durationMs = Date.now() - start;
        const finalized = finalizeCodexExecJsonState(streamState);
        const finalText = finalized.text || stderr.trim();
        if (code !== 0 && !finalText) {
          reject(new Error(`${this.name} exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`));
          return;
        }
        resolve({
          text: finalText,
          ok: finalized.ok,
          sessionId: finalized.sessionId,
          costUsd: undefined,
          numTurns: finalized.numTurns,
          durationMs,
          modelUsage: finalized.usage
            ? {
                [resolvedModel]: {
                  inputTokens: finalized.usage.inputTokens,
                  outputTokens: finalized.usage.outputTokens,
                  cacheReadInputTokens: finalized.usage.cacheReadInputTokens,
                  cacheCreationInputTokens: 0,
                  costUSD: 0,
                  uncachedInputTokens: finalized.usage.uncachedInputTokens,
                  lastInputTokens: finalized.usage.lastInputTokens,
                  lastOutputTokens: finalized.usage.lastOutputTokens,
                  lastCacheReadInputTokens: finalized.usage.lastCacheReadInputTokens,
                  lastTotalTokens: finalized.usage.lastTotalTokens,
                },
              }
            : undefined,
        });
      });
    });

    return { proc, result, getSessionId: () => streamState.sessionId };
  }

  async runQuery(opts: BackendQueryOpts): Promise<QueryResult> {
    return this.spawnCodex(this.buildExecArgs(opts), opts, opts.onMessage).result;
  }

  runSupervised(opts: BackendQueryOpts): SupervisedResult {
    const { proc, result, getSessionId } = this.spawnCodex(this.buildExecArgs(opts), opts, opts.onMessage);
    const streamInput = this.capabilities.has("interactive_input")
      ? async (input: AsyncIterable<UserInputMessage>) => {
          const msg = await materializeUserInput(input);
          const sessionId = msg?.sessionId ?? getSessionId();
          if (!msg || !sessionId) {
            throw new Error(`${this.name} session has no resumable session id for injected input`);
          }
          const resume = this.spawnCodex(this.buildResumeArgs(sessionId, msg.content, opts), opts, opts.onMessage);
          await resume.result;
        }
      : undefined;

    return {
      handle: makeHandle(
        this.name,
        this.capabilities,
        async () => {
          if (!proc.killed) {
            proc.kill("SIGTERM");
            setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
          }
        },
        streamInput,
      ),
      result,
    };
  }
}

class CodexBackend extends BaseCodexBackend {
  readonly name = "codex" as const;
  readonly capabilities = capabilitySet("session_interrupt", "subagents");
}

class OpenAIBackend extends BaseCodexBackend {
  readonly name = "openai" as const;
  readonly capabilities = capabilitySet("interactive_input", "session_interrupt", "subagents", "native_system_prompt");
}

export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /rate.?limit|overloaded|usage.?limit|too many requests|429|quota|capacity/.test(msg);
}

export function isBillingError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /unpaid invoice|payment required|billing|subscription|insufficient credit/.test(msg);
}

export function backendSupportsCapabilities(
  backendName: BackendName,
  requiredCapabilities?: BackendCapability[],
): boolean {
  if (!requiredCapabilities || requiredCapabilities.length === 0) return true;
  const backend = getBackend(backendName);
  return requiredCapabilities.every((capability) => backend.capabilities.has(capability));
}

const codexBackend = new CodexBackend();
const openaiBackend = new OpenAIBackend();

function runtimeHintForModel(model?: string): RuntimeHint {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return "auto";
  return "auto";
}

export function resolveBackend(opts: ResolveBackendOpts = {}): AgentBackend {
  const hint = opts.routeHint && opts.routeHint !== "auto" ? opts.routeHint : runtimeHintForModel(opts.model);
  switch (hint) {
    case "codex":
      return codexBackend;
    case "openai":
      return openaiBackend;
    case "auto":
    default:
      if (backendSupportsCapabilities("codex", opts.requiredCapabilities)) return codexBackend;
      if (backendSupportsCapabilities("openai", opts.requiredCapabilities)) return openaiBackend;
      return codexBackend;
  }
}

export function getBackend(name: BackendName): AgentBackend {
  switch (name) {
    case "codex":
      return codexBackend;
    case "openai":
      return openaiBackend;
  }
}

export function getEffectiveBackendName(opts: ResolveBackendOpts = {}): BackendName {
  return resolveBackend(opts).name;
}
