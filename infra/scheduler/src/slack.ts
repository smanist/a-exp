/**
 * Slack integration for the a-exp scheduler.
 *
 * MVP scope:
 * - DM-only
 * - designated user only
 * - plain-text replies and notifications
 * - no channel UX, file uploads, or Block Kit authoring
 */

import { App, LogLevel } from "@slack/bolt";

import { spawnAgent, AGENT_PROFILES } from "./agent.js";
import { getPendingApprovals, type ApprovalItem } from "./notify.js";
import type { ExecutionResult } from "./executor.js";
import type { Job } from "./types.js";

export type AExpCommandInput = Record<string, unknown>;
export type AExpCommandResult = {
  ok: boolean;
  response: string;
};

interface SlackEnv {
  botToken?: string;
  appToken?: string;
  userId?: string;
}

interface SlackStartOpts {
  repoDir: string;
  store?: unknown;
}

interface SlackMessageLike {
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
}

const MAX_THREAD_CHARS = 12_000;
const MAX_SLACK_TEXT = 39_000;

let app: App | null = null;
let socketStarted = false;
let handlerRegistered = false;
let startPromise: Promise<void> | null = null;
let botUserIdOverride: string | null = null;
let repoDirRef: string | null = null;
let dmChannelId: string | null = null;

function log(msg: string): void {
  console.log(`[slack] ${msg}`);
}

function getSlackEnv(): SlackEnv {
  return {
    botToken: process.env["SLACK_BOT_TOKEN"],
    appToken: process.env["SLACK_APP_TOKEN"],
    userId: botUserIdOverride ?? process.env["SLACK_USER_ID"],
  };
}

function truncateText(text: string, max = MAX_SLACK_TEXT): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function normalizeText(text: string): string {
  return text.trim().replace(/\r\n/g, "\n");
}

function unsupported(feature: string): void {
  log(`${feature} is not supported in the DM-only Slack MVP.`);
}

async function ensureApp(): Promise<App | null> {
  const env = getSlackEnv();
  if (!env.botToken || !env.appToken || !env.userId) return null;

  if (!app) {
    app = new App({
      token: env.botToken,
      appToken: env.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }
  return app;
}

async function ensureDmChannel(): Promise<string | null> {
  const env = getSlackEnv();
  const appInstance = await ensureApp();
  if (!appInstance || !env.userId) return null;
  if (dmChannelId) return dmChannelId;

  try {
    const opened = await appInstance.client.conversations.open({ users: env.userId });
    const openedChannelId = opened.channel?.id;
    if (!openedChannelId) {
      log("Failed to resolve designated user's DM channel.");
      return null;
    }
    dmChannelId = openedChannelId;
    return dmChannelId;
  } catch (err) {
    log(`Failed to open designated user's DM channel: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function postText(
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string | undefined> {
  const appInstance = await ensureApp();
  if (!appInstance) return undefined;

  try {
    const result = await appInstance.client.chat.postMessage({
      channel,
      text: truncateText(text),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return result.ts ?? undefined;
  } catch (err) {
    log(`Failed to post Slack message: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function fetchThreadTranscript(
  channel: string,
  threadTs: string,
  humanUserId: string,
): Promise<string | undefined> {
  const appInstance = await ensureApp();
  if (!appInstance) return undefined;

  try {
    const replies = await appInstance.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 100,
    });
    const messages = replies.messages as SlackMessageLike[] | undefined;
    if (!messages || messages.length <= 1) return undefined;
    return formatThreadMessages(messages, humanUserId);
  } catch (err) {
    log(`Failed to fetch Slack thread replies: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function buildDmPrompt(
  repoDir: string,
  latestMessage: string,
  threadTranscript?: string,
): string {
  const parts = [
    "You are a-exp, responding in a Slack DM to the designated operator.",
    `Repository root: ${repoDir}`,
    "This is the write-capable operator interface. You may use normal mutating tools when needed.",
    "Keep replies concise, plain-text, and Slack-friendly.",
    "Treat this Slack thread as the full conversation boundary. Do not assume memory from other Slack threads.",
    "Do not use slash-command UX, action tags, channel-only workflows, or file-upload UX.",
    "If the user asks you to act, do the work directly instead of only describing next steps.",
  ];

  if (threadTranscript) {
    parts.push(`## Existing Slack Thread\n${threadTranscript}`);
  }

  parts.push(`## Latest Operator Message\n${latestMessage.trim()}`);
  return parts.join("\n\n");
}

function registerDmHandler(appInstance: App): void {
  if (handlerRegistered) return;

  appInstance.message(async (args: any) => {
    const message = args.message as SlackMessageLike;
    const client = args.client as App["client"];
    const env = getSlackEnv();

    if (message.subtype) return;
    if (message.channel_type !== "im") return;
    if (!message.channel || !message.ts || !message.text?.trim()) return;
    if (!env.userId || message.user !== env.userId) return;

    const threadTs = message.thread_ts ?? message.ts;
    const activeRepoDir = repoDirRef;
    if (!activeRepoDir) {
      await postText(
        message.channel,
        ":warning: Slack DM chat is not initialized with a repository yet. Start the scheduler daemon first.",
        threadTs,
      );
      return;
    }

    const threadTranscript =
      threadTs !== message.ts
        ? await fetchThreadTranscript(message.channel, threadTs, env.userId)
        : undefined;
    const prompt = buildDmPrompt(activeRepoDir, message.text, threadTranscript);

    let lastPostedText: string | null = null;
    const rememberPosted = async (text: string): Promise<void> => {
      const postedTs = await postText(message.channel!, text, threadTs);
      if (postedTs) lastPostedText = text;
    };

    try {
      const flusher = { flush: async () => {} };
      const handler = async (msg: { type?: string; message?: { content?: unknown }; result?: string }) => {
        if (msg.type !== "assistant") return;
        const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
        const text = content
          .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
          .filter(Boolean)
          .join("\n")
          .trim();
        if (text) await rememberPosted(text);
      };

      const { result } = spawnAgent({
        profile: AGENT_PROFILES.chat,
        prompt,
        cwd: activeRepoDir,
        onMessage: handler,
      });

      result
        .then(async (agentResult) => {
          await flusher.flush();
          const finalText = agentResult.text.trim();
          if (!finalText) {
            if (agentResult.timedOut) {
              await rememberPosted(":hourglass: Session timed out before producing a final reply.");
            }
            return;
          }
          if (normalizeText(finalText) !== normalizeText(lastPostedText ?? "")) {
            await rememberPosted(finalText);
          }
        })
        .catch(async (err) => {
          log(`Slack DM session failed: ${err instanceof Error ? err.message : String(err)}`);
          await rememberPosted(`:x: Slack DM session failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    } catch (err) {
      log(`Slack DM handler failed: ${err instanceof Error ? err.message : String(err)}`);
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text: `:x: Slack DM handler failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  handlerRegistered = true;
}

function formatApprovalSummary(items: ApprovalItem[]): string {
  const lines = [`:warning: *Pending approvals:* ${items.length}`];
  for (const item of items.slice(0, 5)) {
    lines.push(`- [${item.date}] ${item.title} (${item.project}) [${item.type}]`);
  }
  if (items.length > 5) {
    lines.push(`- ...and ${items.length - 5} more`);
  }
  return lines.join("\n");
}

function formatSessionCompletion(
  job: Job,
  result: ExecutionResult,
  approvals: ApprovalItem[],
): string {
  const lines: string[] = [];
  const status = result.ok
    ? (result.timedOut ? ":hourglass: *Session timed out*" : ":white_check_mark: *Session complete*")
    : ":x: *Session failed*";

  lines.push(`${status} — ${job.name}`);
  lines.push(`Duration: ${Math.round(result.durationMs / 1000)}s`);
  if (result.runtime) lines.push(`Runtime: ${result.runtime}`);
  if (result.costUsd !== undefined) lines.push(`Cost: $${result.costUsd.toFixed(4)}`);
  if (result.numTurns !== undefined) lines.push(`Turns: ${result.numTurns}`);
  if (approvals.length > 0) lines.push(`Pending approvals created: ${approvals.length}`);
  if (result.error) lines.push(`Error: ${truncateText(result.error, 500)}`);

  return lines.join("\n");
}

export function isConfigured(): boolean {
  const env = getSlackEnv();
  return !!(env.botToken && env.appToken && env.userId);
}

export function setBotUserId(id: string): void {
  botUserIdOverride = id;
  dmChannelId = null;
}

export async function startSlackBot(opts: SlackStartOpts): Promise<void> {
  repoDirRef = opts.repoDir;

  if (!isConfigured()) {
    log("Not configured (need SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_USER_ID). Skipping.");
    return;
  }

  if (socketStarted) return;
  if (startPromise) {
    await startPromise;
    return;
  }

  startPromise = (async () => {
    const appInstance = await ensureApp();
    if (!appInstance) return;
    registerDmHandler(appInstance);
    await appInstance.start();
    socketStarted = true;
    log("Bot connected via Socket Mode (DM-only mode).");
  })();

  try {
    await startPromise;
  } finally {
    startPromise = null;
  }
}

export async function stopSlackBot(): Promise<void> {
  if (startPromise) {
    await startPromise.catch(() => {});
  }

  if (app && socketStarted) {
    try {
      await app.stop();
    } catch (err) {
      log(`Failed to stop Slack bot cleanly: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  app = null;
  socketStarted = false;
  handlerRegistered = false;
  dmChannelId = null;
}

export async function dm(text: string): Promise<string | undefined> {
  const channel = await ensureDmChannel();
  if (!channel) return undefined;
  return postText(channel, text);
}

export async function dmThread(threadTs: string, text: string): Promise<void> {
  const channel = await ensureDmChannel();
  if (!channel) return;
  await postText(channel, text, threadTs);
}

export async function dmBlocks(_blocks: unknown[], fallbackText: string): Promise<void> {
  await dm(fallbackText);
}

export async function dmFiles(_files: unknown[], _text?: string): Promise<void> {
  unsupported("dmFiles");
}

export async function dmThreadFiles(_threadTs: string, _files: unknown[], _text?: string): Promise<void> {
  unsupported("dmThreadFiles");
}

export async function channelFiles(_channel: string, _files: unknown[], _text?: string): Promise<void> {
  unsupported("channelFiles");
}

export async function resolveDisplayName(userId: string): Promise<string> {
  const appInstance = await ensureApp();
  if (!appInstance) return userId;

  try {
    const info = await appInstance.client.users.info({ user: userId });
    const displayName = info.user?.profile?.display_name?.trim();
    if (displayName) return displayName;
    if (info.user?.real_name) return info.user.real_name;
    if (info.user?.name) return info.user.name;
    return userId;
  } catch {
    return userId;
  }
}

export async function resolveThreadUserNames<T extends { user?: string }>(messages: T[]): Promise<T[]> {
  return messages;
}

export function gracefulRestartMessage(runningCount: number): string {
  if (runningCount > 0) {
    return `Scheduler restart requested. Waiting for ${runningCount} running session(s) to finish.`;
  }
  return "Scheduler restart requested.";
}

export function startupMessage(): string {
  return "Scheduler started. Slack DM interface is ready for the designated operator.";
}

export async function handleAExpCommand(_input: AExpCommandInput): Promise<AExpCommandResult> {
  unsupported("handleAExpCommand");
  return { ok: false, response: "Slash commands are not available in the DM-only Slack MVP." };
}

export async function handleBotChannelJoin(): Promise<void> {
  unsupported("handleBotChannelJoin");
}

export function setPersistenceDir(_dir: string | null): void {
  // Compatibility shim for the reference Slack implementation.
}

export async function notifyBotStarted(): Promise<void> {
  await dm(startupMessage());
}

export async function notifySessionStarted(
  jobName: string,
  runId: string,
): Promise<{ channel: string; threadTs: string } | null> {
  const channel = await ensureDmChannel();
  if (!channel) return null;
  const threadTs = await postText(channel, `:rocket: *Session started* — ${jobName}\nRun ID: ${runId}`);
  if (!threadTs) return null;
  return { channel, threadTs };
}

export async function notifySessionComplete(
  job: Job,
  result: ExecutionResult,
  approvals: ApprovalItem[],
  threadTs?: string,
): Promise<void> {
  const summary = formatSessionCompletion(job, result, approvals);
  if (threadTs) {
    await dmThread(threadTs, summary);
    return;
  }
  await dm(summary);
}

export async function notifyPendingApprovals(dir: string): Promise<void> {
  const items = await getPendingApprovals(dir);
  if (items.length === 0) return;
  await dm(formatApprovalSummary(items));
}

export async function notifyBudgetBlocked(jobName: string, reason: string): Promise<void> {
  await dm(`:no_entry: *Budget blocked* — ${jobName}\nReason: ${reason}`);
}

export async function notifyEvolution(description: string): Promise<void> {
  await dm(`:seedling: *Scheduler self-evolution*\n${description}`);
}

export async function notifyGracefulRestart(): Promise<void> {
  await dm(gracefulRestartMessage(0));
}

export async function notifyFleetCompletion(): Promise<void> {
  unsupported("notifyFleetCompletion");
}

export async function notifyFleetEscalation(): Promise<void> {
  unsupported("notifyFleetEscalation");
}

export async function notifyFleetDrain(): Promise<void> {
  unsupported("notifyFleetDrain");
}

export async function notifyFleetStarvation(): Promise<void> {
  unsupported("notifyFleetStarvation");
}

export async function notifyFleetLowUtilization(): Promise<void> {
  unsupported("notifyFleetLowUtilization");
}

export async function notifyFleetStatus(): Promise<void> {
  unsupported("notifyFleetStatus");
}

export function formatThreadMessages(
  messages: SlackMessageLike[] = [],
  humanUserId?: string,
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const text = msg.text?.trim();
    if (!text) continue;

    const ts = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString().slice(11, 19) : "??:??";
    const sender = msg.bot_id ? "a-exp" : msg.user && msg.user === humanUserId ? "Operator" : "User";
    const truncated = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
    lines.push(`[${ts}] ${sender}: ${truncated}`);
  }

  let result = lines.join("\n");
  if (result.length > MAX_THREAD_CHARS) {
    const header = lines.slice(0, 3).join("\n");
    const tail = lines.slice(-20).join("\n");
    result = `${header}\n...(earlier messages truncated)...\n${tail}`;
    if (result.length > MAX_THREAD_CHARS) {
      result = result.slice(-MAX_THREAD_CHARS);
    }
  }

  return result;
}
