/** Slack Bot for a-exp scheduler. Socket Mode for multi-channel interaction.
 *  Supports DMs (designated user), dev-mode channels (full access), and chat-mode channels (read-only Q&A). */

import { App, LogLevel } from "@slack/bolt";
import type { Job, FleetWorkerResult } from "./types.js";
import type { FleetScheduler } from "./fleet-scheduler.js";
import { formatFleetStatusReport } from "./fleet-status.js";
import type { ExecutionResult } from "./executor.js";
import {
  getPendingApprovals,
  buildSessionBlocks,
  buildApprovalBlocks,
  readAllBudgetStatuses,
  getSessionCommitSummary,
  type ApprovalItem,
} from "./notify.js";
import { EXCLUDED_PROJECTS } from "./constants.js";
import { processMessage, clearConversation, type ProcessMessageOpts } from "./chat.js";
import { autoFixExperiment } from "./event-agents.js";
import type { JobStore } from "./store.js";
import {
  getSession,
  addWatcher,
  setWatchCallback,
  type BufferedMessage,
} from "./session.js";
import {
  startExperimentWatcher,
  stopExperimentWatcher,
  setNewExperimentCallback,
  tailLog,
  type ExperimentEvent,
} from "./experiments.js";
import {
  createLivingMessage,
  scheduleLivingMessageUpdate,
  finalizeLivingMessage,
  findLivingMessage,
  isLivingMessageEnabled,
} from "./living-message.js";
import { uploadFiles, type FileUpload, type ImageUpload, type UploadResult } from "./slack-files.js";
import { getEffectiveBackendName } from "./backend.js";
import {
  getModelPreference,
  setModelPreference,
  clearModelPreference,
  initModelPreference,
} from "./model-preference.js";
import {
  initChannelModes,
  getChannelMode,
  setChannelMode,
  removeChannelMode,
  isDesignatedUser,
  hasChannelConfigs,
  getChannelTeam,
  type ChannelMode,
} from "./channel-mode.js";
import {
  setMaxTurns,
  getMaxTurns,
  removeMaxTurns,
  incrementBotReply,
  isThreadAtLimit,
  getThreadLimitMessage,
} from "./thread-turns.js";
import {
  setThreadMode,
  isThreadActive,
  parseThreadModeCommand,
  getThreadMode,
} from "./thread-mode.js";

/** Pick the best display name from a Slack user info object.
 *  Prefers profile.display_name > real_name > name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveDisplayName(user: any): string | undefined {
  if (!user) return undefined;
  const displayName = user.profile?.display_name?.trim();
  if (displayName) return displayName;
  if (user.real_name) return user.real_name;
  return user.name || undefined;
}

/** Resolve display names for all unique non-bot users in a set of thread messages.
 *  Returns a Map<userId, displayName>. Failures are silently skipped. */
export async function resolveThreadUserNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
): Promise<Map<string, string>> {
  const userIds = new Set<string>();
  for (const msg of messages) {
    if (!msg.bot_id && msg.user) {
      userIds.add(msg.user as string);
    }
  }

  const names = new Map<string, string>();
  const lookups = [...userIds].map(async (uid) => {
    try {
      const info = await client.users.info({ user: uid });
      const name = resolveDisplayName(info.user);
      if (name) names.set(uid, name);
    } catch {
      // Non-critical — user will appear as "User" fallback
    }
  });
  await Promise.all(lookups);
  return names;
}

// Read env vars lazily (not at import time) so .env loading in cli.ts takes effect
function getSlackEnv() {
  return {
    botToken: process.env["SLACK_BOT_TOKEN"],
    appToken: process.env["SLACK_APP_TOKEN"],
    userId: process.env["SLACK_USER_ID"],
  };
}

let app: App | null = null;
let userId: string | null = null;
let botUserId: string | null = null;
let repoDir: string | null = null;
let storeRef: JobStore | null = null;
let fleetSchedulerRef: FleetScheduler | null = null;
let dmChannelId: string | null = null;
/** Channel (non-DM) conversation keys — suppresses intermediate output in the watch forwarder. */
const channelConvKeys = new Set<string>();

/** Override the bot's own user ID (for testing). */
export function setBotUserId(id: string | null): void {
  botUserId = id;
}

export function isConfigured(): boolean {
  const env = getSlackEnv();
  return !!(env.botToken && env.appToken && env.userId);
}

export async function startSlackBot(opts: {
  repoDir: string;
  store: JobStore;
  fleetScheduler?: FleetScheduler;
}): Promise<void> {
  const env = getSlackEnv();
  if (!env.botToken || !env.appToken || !env.userId) {
    console.log("[slack] Not configured (need SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_USER_ID). Skipping.");
    return;
  }

  userId = env.userId;
  repoDir = opts.repoDir;
  storeRef = opts.store;
  fleetSchedulerRef = opts.fleetScheduler ?? null;

  initChannelModes();
  initModelPreference();

  app = new App({
    token: env.botToken,
    appToken: env.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  // Handle messages — DMs, dev-mode channels, and chat-mode channels
  app.message(async ({ message, say, client }) => {
    if (message.subtype || !("text" in message)) return;
    const raw = message.text?.trim() ?? "";
    const text = raw.toLowerCase();
    const msgTs = (message as { ts: string }).ts;
    const msgChannel = (message as { channel: string }).channel;
    const msgUser = (message as { user?: string }).user;
    const channelType = (message as { channel_type?: string }).channel_type;
    // Thread parent ts: if this is a reply in an existing thread use that,
    // otherwise start a new thread from this message.
    const threadTs = (message as { thread_ts?: string }).thread_ts ?? msgTs;
    // Conversation key scoped to thread, so each thread has its own context.
    const convKey = `${msgChannel}:${threadTs}`;

    // Determine interaction mode based on channel context
    const isDm = channelType === "im";
    let channelMode: ChannelMode | null = null;

    if (isDm) {
      // DMs: only respond to the designated user
      if (!msgUser || !isDesignatedUser(msgUser)) {
        console.log(`[slack] Ignoring DM from non-designated user: ${msgUser}`);
        return;
      }
      channelMode = "dev";
    } else {
      // Channels: look up configured mode
      channelMode = getChannelMode(msgChannel);
      if (!channelMode) {
        // Unregistered channel — ignore silently
        return;
      }
    }

    const isChannel = !isDm;

    // Thread mode toggle commands (channel only, before mention-mode gating)
    if (isChannel) {
      const toggleMode = parseThreadModeCommand(raw);
      if (toggleMode !== null) {
        setThreadMode(convKey, toggleMode);
        const modeMsg = toggleMode === "active"
          ? ":zap: Active mode — I'll respond to all messages in this thread."
          : ":bell: Mention mode — I'll only respond to @mentions in this thread.";
        try { await client.reactions.add({ channel: msgChannel, timestamp: msgTs, name: "white_check_mark" }); } catch {}
        await say({ text: modeMsg, thread_ts: threadTs } as any);
        return;
      }

      // In mention mode, skip unless message contains bot @mention
      if (!isThreadActive(convKey)) {
        const hasBotMention = botUserId && raw.includes(`<@${botUserId}>`);
        if (!hasBotMention) return;
      }
    }

    // Strip bot @mention from raw text for cleaner agent input.
    // The message handler processes @mentions directly (no need for app_mention).
    const processRaw = isChannel && botUserId
      ? raw.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim()
      : raw;

    const enableLivingHere = isLivingMessageEnabled() && (isDm || channelMode === "dev");
    if (isChannel && !enableLivingHere) channelConvKeys.add(convKey);

    // Resolve sender display name for multi-user context
    let senderName: string | undefined;
    if (!isDm && msgUser) {
      try {
        const userInfo = await client.users.info({ user: msgUser });
        senderName = resolveDisplayName(userInfo.user);
      } catch {
        // Non-critical — proceed without name
      }
    }

    // React with lightbulb to acknowledge receipt (silently skip if missing reactions:write scope)
    try {
      await client.reactions.add({ channel: msgChannel, timestamp: msgTs, name: "bulb" });
    } catch { /* missing reactions:write scope — non-critical */ }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reply: SayFn = (msg: any) => {
      if (typeof msg === "string") {
        // Block Kit passthrough: chat.ts sends `__BLOCKS__<json>` for rich reports
        if (msg.startsWith("__BLOCKS__")) {
          try {
            const blocks = JSON.parse(msg.slice("__BLOCKS__".length));
            return say({ blocks, text: "Report generated", thread_ts: threadTs } as any);
          } catch { /* fall through to plain text */ }
        }
        return say({ text: msg, thread_ts: threadTs } as any);
      }
      return say({ ...msg, thread_ts: threadTs } as any);
    };

    // Only help and clear are handled directly — everything else goes through the chat agent
    if (text === "help" || text === "h" || text === "?") {
      await respondHelp(reply);
      try { await client.reactions.remove({ channel: msgChannel, timestamp: msgTs, name: "bulb" }); } catch {}
      return;
    }

    if (text === "clear" || text === "reset") {
      clearConversation(convKey);
      await reply(":wastebasket: Conversation cleared.");
      try { await client.reactions.remove({ channel: msgChannel, timestamp: msgTs, name: "bulb" }); } catch {}
      return;
    }

    // Turn limit check: if this thread has hit the channel's max-turns, stop replying
    if (isThreadAtLimit(msgChannel, convKey)) {
      const limitMsg = getThreadLimitMessage(msgChannel);
      if (limitMsg) await reply(limitMsg);
      try { await client.reactions.remove({ channel: msgChannel, timestamp: msgTs, name: "bulb" }); } catch {}
      return;
    }

    // All other messages — route through chat agent
    if (!repoDir || !storeRef) {
      await respondHelp(reply);
      try { await client.reactions.remove({ channel: msgChannel, timestamp: msgTs, name: "bulb" }); } catch {}
      return;
    }

    // Fetch full thread history when replying in an existing thread.
    // This captures bot-posted messages (autofix, deep work, experiment notifications)
    // that aren't in the in-memory conversation state.
    const channelTeam = isChannel ? getChannelTeam(msgChannel) : undefined;
    let processOpts: ProcessMessageOpts = {
      channelMode: channelMode ?? "dev",
      senderName,
      team: channelTeam ?? undefined,
      fleetScheduler: fleetSchedulerRef ?? undefined,
    };
    if (threadTs !== msgTs) {
      try {
        const replies = await client.conversations.replies({
          channel: msgChannel,
          ts: threadTs,
          limit: 100,
        });
        if (replies.messages && replies.messages.length > 1) {
          const threadUserNames = await resolveThreadUserNames(replies.messages, client);
          processOpts.threadMessages = formatThreadMessages(replies.messages, userId ?? undefined, threadUserNames);
        }
      } catch (err) {
        console.error(`[slack] Failed to fetch thread replies: ${err}`);
      }
    }

    let thinkingTs: string | undefined;
    const removeBulb = async () => {
      try { await client.reactions.remove({ channel: msgChannel, timestamp: msgTs, name: "bulb" }); } catch {}
    };
    const removeThinking = async () => {
      if (thinkingTs) {
        try { await client.reactions.remove({ channel: msgChannel, timestamp: thinkingTs, name: "kanata-hmm" }); } catch {}
        thinkingTs = undefined;
      }
    };

    // Post an immediate "processing" indicator so the user sees the bot is working.
    // In channels, the bulb emoji reaction serves as the only working indicator.
    let processingTs: string | undefined;
    if (isDm) {
      try {
        const processingResult = await client.chat.postMessage({
          channel: msgChannel,
          thread_ts: threadTs,
          text: ":hourglass_flowing_sand: _Processing…_",
        });
        processingTs = processingResult.ts ?? undefined;
      } catch {
        // Non-critical — the bot still works without the indicator
      }
    }

    /** Remove or replace the processing indicator. Called once on first real output. */
    let processingCleared = false;
    const clearProcessingIndicator = async (replacementText?: string) => {
      if (processingCleared || !processingTs) return;
      processingCleared = true;
      try {
        if (replacementText) {
          await client.chat.update({ channel: msgChannel, ts: processingTs, text: replacementText });
        } else {
          await client.chat.delete({ channel: msgChannel, ts: processingTs });
        }
      } catch {
        // Graceful degradation: if update/delete fails, the stale indicator stays but is harmless
      }
      processingTs = undefined;
    };

    let chatSessionId: string | null = null;
    // Track last agent text when living messages suppress onProgress.
    // Two variables: lastSuppressedAgentText for actual model text,
    // lastSuppressedText for any progress (including :gear: tool summaries).
    // The flusher's debounce timer can overwrite lastSuppressedText with a
    // tool summary between the last agent text and onComplete, so we need
    // the separate agentText variable to survive that race.
    // See diagnosis-chat-dedup-eats-response-with-living-messages-2026-02-19.md.
    let lastSuppressedText: string | null = null;
    let lastSuppressedAgentText: string | null = null;

    const syncResult = await processMessage(processRaw, convKey, repoDir, storeRef, {
      onProgress: async (progressText) => {
        // In channels without living messages: suppress all intermediate output, just track for dedup recovery.
        if (isChannel && !enableLivingHere) {
          lastSuppressedText = progressText;
          if (!progressText.startsWith(":gear:")) {
            lastSuppressedAgentText = progressText;
          }
          return;
        }

        // When living messages are enabled, progress is handled via the watch forwarder.
        // Track text so onComplete can recover from dedup false positives.
        // Still clear the processing indicator on first output.
        if (enableLivingHere) {
          await clearProcessingIndicator();
          lastSuppressedText = progressText;
          // Tool summaries start with :gear: — don't let them overwrite agent text
          if (!progressText.startsWith(":gear:")) {
            lastSuppressedAgentText = progressText;
          }
          return;
        }

        // First real output: replace the processing indicator with this text.
        // The updated message becomes the new "thinking" message for subsequent updates.
        if (!processingCleared && processingTs) {
          const replacedTs = processingTs;
          await clearProcessingIndicator(progressText);
          thinkingTs = replacedTs;
          if (thinkingTs) {
            try { await client.reactions.add({ channel: msgChannel, timestamp: thinkingTs, name: "kanata-hmm" }); } catch {}
          }
          return;
        }

        await removeThinking();
        const posted = await reply(progressText);
        thinkingTs = (posted as { ts?: string })?.ts;
        if (thinkingTs) {
          try { await client.reactions.add({ channel: msgChannel, timestamp: thinkingTs, name: "kanata-hmm" }); } catch {}
        }
      },
      onComplete: async (completionText) => {
        // Capture fallback text BEFORE any await — the tool batch flusher's
        // debounce timer can fire during async yields and overwrite
        // lastSuppressedText with a tool summary instead of the agent's text.
        // Use lastSuppressedAgentText (immune to flusher overwrites) as primary fallback.
        // See diagnosis-chat-dedup-eats-response-with-living-messages-2026-02-19.md.
        const fallbackText = lastSuppressedAgentText ?? lastSuppressedText;
        lastSuppressedAgentText = null;
        lastSuppressedText = null;
        await clearProcessingIndicator();
        await removeThinking();
        // Dedup sends null when the final text matches the last progress message,
        // meaning "already posted via onProgress." For DMs without living messages,
        // progress IS posted so null correctly means "already visible." But in channels
        // (with or without living messages), onProgress is suppressed — the text was
        // saved to lastSuppressedAgentText, never posted. Use fallbackText to recover.
        // See diagnosis-chat-mode-silent-double-fire-2026-03-06.
        const progressWasSuppressed = isChannel || enableLivingHere;
        const textToPost = completionText === null
          ? (progressWasSuppressed ? fallbackText : null)
          : (completionText || fallbackText);
        if (textToPost) {
          await reply(textToPost);
          incrementBotReply(convKey);
        }
        await removeBulb();

        // Finalize living message for chat sessions (scheduled jobs finalize via notifySessionComplete).
        // chatSessionId is captured after processMessage returns (see below).
        if (enableLivingHere && chatSessionId) {
          const session = getSession(chatSessionId);
          await finalizeLivingMessage(client, chatSessionId, {
            state: "complete",
            costUsd: session?.costUsd,
            turnCount: session?.numTurns ?? 0,
          });
        }
      },
    }, processOpts);

    // Capture session ID for living message finalization in onComplete callback
    if (syncResult && "sessionId" in syncResult) {
      chatSessionId = syncResult.sessionId;
    }

    // Sync response (confirmations) — post immediately and clean up
    if (syncResult && "text" in syncResult) {
      await clearProcessingIndicator();
      await reply(syncResult.text);
      incrementBotReply(convKey);
      await removeBulb();
    }
    // Async session with sessionId → set up living message if enabled
    else if (syncResult && "sessionId" in syncResult && enableLivingHere) {
      const { sessionId } = syncResult;
      try {
        // Determine maxTurns from session profile
        const session = getSession(sessionId);
        const maxTurns = session?.jobName === "deep-work" ? 64 : 16;

        // Create the living message
        const livingMsg = await createLivingMessage({
          client,
          channel: msgChannel,
          threadTs,
          sessionId,
          maxTurns,
        });

        // Set up watch callback to forward agent activity to the living message
        if (session) {
          addWatcher(sessionId, convKey);
          // The watch forwarder in setupWatchForwarder() will call scheduleLivingMessageUpdate
        }

        // Living message takes over as the visual indicator — remove the processing message
        await clearProcessingIndicator();
        console.log(`[slack] Living message created for ${session?.jobName ?? "chat"} session ${sessionId} (maxTurns=${maxTurns})`);
      } catch (err) {
        console.error(`[slack] Failed to create living message: ${err}`);
        // Fallback: living message creation failed, but agent is still running
      }
      await removeBulb();
    }
    // Async session, no living messages → use existing behavior
    else if (syncResult && "sessionId" in syncResult) {
      // Agent running in background, callbacks handle progress via onProgress
      // Lightbulb stays until onComplete removes it
    }
    // null return → legacy path (shouldn't happen with new return type)
  });

  // Handle @mentions in channels.
  // IMPORTANT: For configured channels, the message handler already processes
  // @mentions (via the isThreadActive / hasBotMention check). Processing them
  // here too causes double-fire: both handlers spawn sessions on the same convKey,
  // the second interrupts the first, and dedup eats the response because onProgress
  // was suppressed. Only handle thread mode toggles here; defer message processing
  // to the message handler. See diagnosis-chat-mode-silent-double-fire-2026-03-06.
  app.event("app_mention", async ({ event, client }) => {
    const raw = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!raw) return;

    const msgChannel = event.channel;
    const msgTs = event.ts;
    const threadTs = event.thread_ts ?? msgTs;
    const convKey = `${msgChannel}:${threadTs}`;

    const channelMode = getChannelMode(msgChannel);
    if (!channelMode) return;

    // Thread mode toggle via @mention (e.g., "@bot active on")
    const toggleMode = parseThreadModeCommand(raw);
    if (toggleMode !== null) {
      setThreadMode(convKey, toggleMode);
      const modeMsg = toggleMode === "active"
        ? ":zap: Active mode — I'll respond to all messages in this thread."
        : ":bell: Mention mode — I'll only respond to @mentions in this thread.";
      try { await client.reactions.add({ channel: msgChannel, timestamp: msgTs, name: "white_check_mark" }); } catch {}
      await client.chat.postMessage({ channel: msgChannel, thread_ts: threadTs, text: modeMsg });
      return;
    }

    // Message processing is handled by the message handler — skip here to prevent
    // double-fire. The message handler detects @mentions via hasBotMention check.
  });

  // Restrict channel invitations — only designated user can add the bot
  app.event("member_joined_channel", async ({ event, client }) => {
    await handleBotChannelJoin(event as { user: string; channel: string; inviter?: string }, client);
  });

  // Publish App Home tab when user visits it
  app.event("app_home_opened", async ({ event }) => {
    if (event.tab !== "home") return;
    await publishHomeTab(event.user);
  });

  // Handle /a-exp slash command (ADR 0033)
  app.command("/a-exp", async ({ command, ack, respond }) => {
    await ack();
    const result = await handleAExpCommand({
      text: command.text ?? "",
      userId: command.user_id,
      channelId: command.channel_id,
    });
    await respond({ text: result.text, response_type: "ephemeral" });
  });

  await app.start();

  // Resolve bot's own user ID for channel invitation restriction
  try {
    const authResult = await app.client.auth.test();
    botUserId = (authResult as { user_id?: string }).user_id ?? null;
    if (botUserId) {
      console.log(`[slack] Bot user ID: ${botUserId}`);
    }
  } catch (err) {
    console.error(`[slack] Failed to resolve bot user ID: ${err}`);
  }

  if (hasChannelConfigs()) {
    console.log("[slack] Bot connected via Socket Mode (multi-channel mode enabled).");
  } else {
    console.log("[slack] Bot connected via Socket Mode (DM-only mode).");
  }

  // Open DM channel on startup for reliable outbound messaging
  try {
    const result = await app.client.conversations.open({ users: userId });
    dmChannelId = result.channel?.id ?? null;
    if (dmChannelId) {
      console.log(`[slack] DM channel: ${dmChannelId}`);
    }
  } catch (err) {
    console.error(`[slack] Failed to open DM channel: ${err}`);
  }

  // Set up watch callback for session supervision
  setupWatchForwarder();

  // Start fleet completion flush interval
  startFleetFlushInterval();

  // Set up experiment completion watcher
  startExperimentWatcher(handleExperimentEvent, 10_000, opts.repoDir);

  // Notify when new experiments are discovered or registered
  setNewExperimentCallback(({ project, id, source }) => {
    const icon = source === "api" ? ":microscope:" : ":mag:";
    const verb = source === "api" ? "tracked" : "discovered";
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    dm(`${icon} *Experiment ${verb}:* ${project}/${id} (${ts})`);
  });

  // Try publishing home tab on startup (will fail silently if feature not enabled)
  await publishHomeTab(userId).catch(() => {});

  // Notify that the bot has (re)started
  await notifyBotStarted();
}

export async function stopSlackBot(): Promise<void> {
  stopExperimentWatcher();
  if (app) {
    await app.stop();
    console.log("[slack] Bot disconnected.");
  }
}

// --- Outbound: DM the user ---

async function getDmChannel(): Promise<string | null> {
  if (dmChannelId) return dmChannelId;
  if (!app || !userId) return null;
  try {
    const result = await app.client.conversations.open({ users: userId });
    dmChannelId = result.channel?.id ?? null;
  } catch (err) {
    console.error(`[slack] Failed to open DM channel: ${err}`);
  }
  return dmChannelId;
}

export async function dm(text: string): Promise<string | undefined> {
  const channel = await getDmChannel();
  if (!app || !channel) return undefined;
  try {
    const result = await app.client.chat.postMessage({ channel, text });
    return result.ts;
  } catch (err) {
    console.error(`[slack] DM failed: ${err}`);
    return undefined;
  }
}

/** Post a threaded reply to an existing DM message. */
export async function dmThread(threadTs: string, text: string): Promise<void> {
  const channel = await getDmChannel();
  if (!app || !channel) return;
  try {
    await app.client.chat.postMessage({ channel, text, thread_ts: threadTs });
  } catch (err) {
    console.error(`[slack] DM thread reply failed: ${err}`);
  }
}

export async function dmBlocks(blocks: unknown[], fallbackText: string): Promise<void> {
  const channel = await getDmChannel();
  if (!app || !channel) return;
  try {
    await app.client.chat.postMessage({
      channel,
      blocks: blocks as never[],
      text: fallbackText,
    });
  } catch (err) {
    console.error(`[slack] DM failed: ${err}`);
  }
}

/** Upload files to the user's DM channel. Any file type is supported. */
export async function dmFiles(
  files: FileUpload[],
  initialComment?: string,
): Promise<UploadResult> {
  const channel = await getDmChannel();
  if (!app || !channel) return { ok: false, count: 0, error: "Slack not connected" };
  return uploadFiles(app.client, channel, files, { initialComment });
}

/** Upload files as a threaded reply in the user's DM channel. */
export async function dmThreadFiles(
  threadTs: string,
  files: FileUpload[],
  initialComment?: string,
): Promise<UploadResult> {
  const channel = await getDmChannel();
  if (!app || !channel) return { ok: false, count: 0, error: "Slack not connected" };
  return uploadFiles(app.client, channel, files, { threadTs, initialComment });
}

/** Upload files to a specific channel, optionally as a threaded reply. */
export async function channelFiles(
  channel: string,
  files: FileUpload[],
  opts?: { threadTs?: string; initialComment?: string },
): Promise<UploadResult> {
  if (!app) return { ok: false, count: 0, error: "Slack not connected" };
  return uploadFiles(app.client, channel, files, opts);
}

/** @deprecated Use dmFiles instead. */
export const dmImages = dmFiles;
/** @deprecated Use dmThreadFiles instead. */
export const dmThreadImages = dmThreadFiles;

/** Build the startup message text. Exported for testing. */
export function startupMessage(opts: { totalJobs: number; enabledJobs: number; nextRun: string; model: string; runtime: string }): string {
  return (
    `:rocket: *a-exp scheduler started*\n` +
    `Model: ${opts.model}\n` +
    `Runtime: ${opts.runtime}\n` +
    `Jobs: ${opts.totalJobs} total, ${opts.enabledJobs} enabled\n` +
    `Next run: ${opts.nextRun}`
  );
}

export async function notifyBotStarted(): Promise<void> {
  if (!storeRef) return;
  await storeRef.load();
  const jobs = storeRef.list();
  const enabled = jobs.filter((j) => j.enabled);
  const nextMs = storeRef.getNextWakeMs();
  const nextStr = nextMs ? new Date(nextMs).toISOString() : "none";

  const preferredModel = getModelPreference();
  await dm(startupMessage({
    totalJobs: jobs.length,
    enabledJobs: enabled.length,
    nextRun: nextStr,
    model: preferredModel ?? "default",
    runtime: getEffectiveBackendName({ model: preferredModel ?? undefined }),
  }));
}

export async function notifySessionStarted(
  jobName: string,
  runId: string,
): Promise<{ channel: string; threadTs: string } | null> {
  const channel = await getDmChannel();
  if (!app || !channel) return null;
  try {
    const result = await app.client.chat.postMessage({
      channel,
      text: `:arrow_forward: *Session started:* ${jobName} (\`${runId}\`)`,
    });
    const ts = result.ts;
    if (!ts) return null;
    addWatcher(runId, `${channel}:${ts}`);
    return { channel, threadTs: ts };
  } catch (err) {
    console.error(`[slack] Session start DM failed: ${err}`);
    return null;
  }
}

export async function notifySessionComplete(
  job: Job,
  result: ExecutionResult,
  approvals: ApprovalItem[],
  threadTs?: string,
): Promise<void> {
  // Read budget statuses and git commit summary in parallel (before living message
  // finalization so the commit summary appears in the living message too)
  const dir = job.payload.cwd ?? process.cwd();
  const [allBudgets, commitSummary] = await Promise.all([
    readAllBudgetStatuses(dir, EXCLUDED_PROJECTS).catch(() => []),
    result.ok ? getSessionCommitSummary(dir, result.durationMs) : null,
  ]);

  // Finalize living message if enabled — includes work summary so thread
  // context shows what the session accomplished (prevents Q&A friction)
  if (isLivingMessageEnabled() && app && result.sessionId) {
    await finalizeLivingMessage(app.client, result.sessionId, {
      state: result.ok ? "complete" : "failed",
      costUsd: result.costUsd,
      turnCount: result.numTurns ?? 0,
      error: result.ok ? undefined : (result.error ?? "unknown error"),
      workSummary: commitSummary ?? undefined,
    });
  }
  // Include the first budget that has any warning/critical resources, or the first one found
  const alertBudget = allBudgets.find(
    (b) => b.status.resources.some((r) => r.pct >= 90) ||
           (b.status.hoursToDeadline !== undefined && b.status.hoursToDeadline <= 24),
  ) ?? allBudgets[0] ?? null;
  const blocks = buildSessionBlocks(job, result, approvals, alertBudget?.status, alertBudget?.project, commitSummary);
  const fallback = `a-exp session ${result.ok ? "completed" : "failed"}: ${job.name}`;

  if (threadTs) {
    const channel = await getDmChannel();
    if (!app || !channel) return;
    try {
      await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks: blocks as never[],
        text: fallback,
      });
    } catch (err) {
      console.error(`[slack] DM failed: ${err}`);
    }
  } else {
    await dmBlocks(blocks, fallback);
  }
}

export async function notifyPendingApprovals(dir: string): Promise<void> {
  const approvals = await getPendingApprovals(dir);
  if (approvals.length === 0) return;
  const blocks = buildApprovalBlocks(approvals);
  await dmBlocks(blocks, `${approvals.length} pending approval(s)`);
}

/** Notify that a job was blocked by the budget gate. */
export async function notifyBudgetBlocked(jobName: string, reason: string): Promise<void> {
  await dm(`:no_entry: *Budget gate blocked session:* ${jobName}\n${reason}`);
}

/** Notify that a self-evolution is being applied and scheduler will restart. */
export async function notifyEvolution(description: string): Promise<void> {
  await dm(`:dna: *Scheduler self-evolution applied:*\n${description}\nRestarting...`);
}

/** Build the message text for a graceful restart notification. Exported for testing. */
export function gracefulRestartMessage(runningSessions: number, model?: string, runtime?: string): string {
  const detail = runningSessions > 0
    ? `Draining ${runningSessions} running session(s) before exit.`
    : `No sessions running — restarting immediately.`;
  const modelLine = model ? `\nModel: ${model}` : "";
  const runtimeLine = runtime ? `\nRuntime: ${runtime}` : "";
  return `:arrows_counterclockwise: *Graceful restart requested*\n${detail}${modelLine}${runtimeLine}`;
}

/** Notify that a graceful restart was triggered via /api/restart (ADR 0018). */
export async function notifyGracefulRestart(runningSessions: number): Promise<void> {
  const preferredModel = getModelPreference();
  await dm(gracefulRestartMessage(
    runningSessions,
    preferredModel ?? "default",
    getEffectiveBackendName({ model: preferredModel ?? undefined }),
  ));
}

// --- App Home ---

async function publishHomeTab(userId: string): Promise<void> {
  if (!app) return;
  const jobs = storeRef ? storeRef.list() : [];
  const approvals = repoDir ? await getPendingApprovals(repoDir) : [];
  const enabled = jobs.filter((j) => j.enabled);
  const nextMs = storeRef?.getNextWakeMs();

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "a-exp scheduler" } },
    { type: "section", text: { type: "mrkdwn",
      text: `*Jobs:* ${jobs.length} total, ${enabled.length} enabled\n*Next run:* ${nextMs ? new Date(nextMs).toISOString() : "none"}\n*Pending approvals:* ${approvals.length}`,
    }},
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn",
      text: "*Chat:* DM me naturally — ask about projects, approvals, experiments, sessions, or system status. I understand natural language for everything.\n\n*Examples:* \"What's the status?\" · \"Show approvals\" · \"Approve item 1\" · \"Stop the running session\" · \"Watch session abc\" · \"What experiments are running?\"\n\n*Quick commands:* `help` · `clear`",
    }},
  ];

  await app.client.views.publish({
    user_id: userId,
    view: { type: "home", blocks: blocks as never[] },
  });
}

// --- /a-exp slash command handler (ADR 0033) ---

export interface AExpCommandInput {
  text: string;
  userId: string;
  channelId: string;
}

export interface AExpCommandResult {
  text: string;
}

/** Parse and execute /a-exp slash commands. Exported for testing. */
export async function handleAExpCommand(input: AExpCommandInput): Promise<AExpCommandResult> {
  const args = input.text.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "help") {
    return {
      text:
        `:bulb: */a-exp* commands:\n` +
        `• \`/a-exp mode dev\` — set this channel to dev mode (full access)\n` +
        `• \`/a-exp mode chat\` — set this channel to chat mode (read-only Q&A)\n` +
        `• \`/a-exp mode off\` — remove this channel from a-exp\n` +
        `• \`/a-exp max-turns N\` — limit bot replies per thread to N turns\n` +
        `• \`/a-exp max-turns off\` — remove the turn limit\n` +
        `• \`/a-exp model <name>\` — set the preferred chat/deep-work model\n` +
        `• \`/a-exp model reset\` — reset to default model routing\n` +
        `• \`/a-exp status\` — show this channel's current mode and model\n` +
        `• \`/a-exp help\` — this message\n\n` +
        `*Thread commands* (type in-thread or @mention):\n` +
        `• \`active on\` — respond to all messages in this thread\n` +
        `• \`active off\` — respond only to @mentions (default)`,
    };
  }

  if (subcommand === "max-turns") {
    if (!isDesignatedUser(input.userId)) {
      return { text: `:no_entry: Only the designated a-exp operator can change turn limits.` };
    }

    const valueArg = args[1]?.toLowerCase();
    if (!valueArg) {
      const current = getMaxTurns(input.channelId);
      if (current !== null) {
        return { text: `:information_source: This channel has a *${current}-turn* limit per thread.` };
      }
      return { text: `:information_source: No turn limit set for this channel. Use \`/a-exp max-turns N\` to set one.` };
    }

    if (valueArg === "off" || valueArg === "remove" || valueArg === "none") {
      const removed = removeMaxTurns(input.channelId);
      if (removed) {
        return { text: `:white_check_mark: Turn limit removed for this channel.` };
      }
      return { text: `:information_source: No turn limit was set for this channel.` };
    }

    const n = parseInt(valueArg, 10);
    if (isNaN(n) || n <= 0) {
      return { text: `:warning: Invalid turn limit \`${valueArg}\`. Provide a positive number (e.g., \`/a-exp max-turns 10\`).` };
    }

    setMaxTurns(input.channelId, n);
    return { text: `:white_check_mark: Turn limit set to *${n}* per thread in this channel.` };
  }

  if (subcommand === "status") {
    const mode = getChannelMode(input.channelId);
    const turnsLimit = getMaxTurns(input.channelId);
    const model = getModelPreference();
    const runtime = getEffectiveBackendName({ model: model ?? undefined });
    const turnsInfo = turnsLimit !== null ? ` Turn limit: *${turnsLimit}* per thread.` : "";
    const modelInfo = model
      ? ` Model: *${model}* (persisted). Runtime: *${runtime}*.`
      : ` Model: *default* (profile-driven). Runtime: *${runtime}*.`;
    if (mode) {
      return { text: `:information_source: This channel is in *${mode}* mode.${turnsInfo}${modelInfo}` };
    }
    return { text: `:information_source: This channel has no mode configured.${turnsInfo}${modelInfo} Use \`/a-exp mode dev\` or \`/a-exp mode chat\` to set one.` };
  }

  if (subcommand === "model") {
    if (!isDesignatedUser(input.userId)) {
      return { text: `:no_entry: Only the designated a-exp operator can change the preferred model.` };
    }

    const modelArg = args.slice(1).join(" ").trim();
    if (!modelArg) {
      const current = getModelPreference();
      const runtime = getEffectiveBackendName({ model: current ?? undefined });
      if (current) {
        return { text: `:information_source: Current model: *${current}* (persisted). Runtime resolves to *${runtime}*. Use \`/a-exp model <name>\` to change it.` };
      }
      return { text: `:information_source: Current model: *default* (profile-driven). Runtime resolves to *${runtime}*. Use \`/a-exp model <name>\` to persist a preference.` };
    }

    if (modelArg === "reset" || modelArg === "default" || modelArg === "clear") {
      await clearModelPreference();
      return { text: `:white_check_mark: Model preference reset to default routing.` };
    }

    await setModelPreference(modelArg);
    const runtime = getEffectiveBackendName({ model: modelArg });
    return { text: `:white_check_mark: Model set to *${modelArg}*. Runtime resolves to *${runtime}*.` };
  }

  if (subcommand === "mode") {
    if (!isDesignatedUser(input.userId)) {
      return { text: `:no_entry: Only the designated a-exp operator can change channel modes.` };
    }

    const modeArg = args[1]?.toLowerCase();
    if (modeArg === "dev" || modeArg === "chat") {
      await setChannelMode(input.channelId, modeArg as ChannelMode);
      const description = modeArg === "dev"
        ? "full access (experiments, approvals, deep work)"
        : "read-only Q&A (no repository modifications)";
      return { text: `:white_check_mark: Channel mode set to *${modeArg}* — ${description}.` };
    }

    if (modeArg === "off" || modeArg === "remove" || modeArg === "none") {
      const removed = await removeChannelMode(input.channelId);
      if (removed) {
        return { text: `:white_check_mark: Channel mode removed. a-exp will no longer respond in this channel.` };
      }
      return { text: `:information_source: This channel was not configured — nothing to remove.` };
    }

    return { text: `:warning: Unknown mode \`${modeArg ?? ""}\`. Use \`dev\`, \`chat\`, or \`off\`.` };
  }

  return { text: `:warning: Unknown command \`${subcommand}\`. Try \`/a-exp help\`.` };
}

// --- Channel invitation restriction ---

/** Handle member_joined_channel events to restrict which users can invite the bot.
 *  Returns the action taken for testability. */
export async function handleBotChannelJoin(
  event: { user: string; channel: string; inviter?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
): Promise<{ action: "stayed" | "left" | "ignored" }> {
  if (!botUserId || event.user !== botUserId) {
    return { action: "ignored" };
  }

  if (event.inviter && isDesignatedUser(event.inviter)) {
    console.log(`[slack] Bot added to ${event.channel} by designated user — staying.`);
    return { action: "stayed" };
  }

  const inviterInfo = event.inviter ? ` by <@${event.inviter}>` : "";
  console.log(`[slack] Bot added to ${event.channel}${inviterInfo} — leaving (not designated user).`);

  try {
    await client.chat.postMessage({
      channel: event.channel,
      text: "Thanks for the invite! However, only the a-exp operator can add me to channels. Please ask them to invite me if you'd like me here.",
    });
  } catch {
    // Posting may fail if bot lacks permission — proceed to leave anyway
  }

  try {
    await client.conversations.leave({ channel: event.channel });
  } catch (err) {
    console.error(`[slack] Failed to leave channel ${event.channel}: ${err}`);
  }

  return { action: "left" };
}

// --- Inbound: respond to DM commands ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SayFn = (msg: any) => Promise<any>;

async function respondHelp(say: SayFn): Promise<void> {
  await say(
    `:bulb: *a-exp scheduler*\n\n` +
    `Talk to me naturally — I can help with projects, experiments, approvals, sessions, and system status.\n\n` +
    `*Examples:*\n` +
    `"What's the status?" — system overview\n` +
    `"Show me pending approvals" — approval queue\n` +
    `"Approve item 1" — approve with confirmation\n` +
    `"Stop the running session" — interrupt a session\n` +
    `"Watch session abc123" — stream live updates\n` +
    `"What experiments are running?" — experiment status\n\n` +
    `\`active on\` — respond to all messages in this thread\n` +
    `\`active off\` — respond only to @mentions in this thread\n` +
    `\`clear\` — reset conversation history\n` +
    `\`help\` — this message\n\n` +
    `I DM you automatically after each session and when approvals need attention.`
  );
}

// --- Experiment completion notifications ---

async function handleExperimentEvent(event: ExperimentEvent): Promise<void> {
  const p = event.progress;
  console.log(`[experiments] Event: ${event.project}/${event.id} → ${event.status} (exit_code=${p.exit_code}, duration=${p.duration_s}s)`);

  // Retrying: brief notification, no autofix — the runner is handling it
  if (event.status === "retrying") {
    const attempt = p.attempt ?? "?";
    const maxAttempts = (p.max_retries ?? 0) + 1;
    const exitCode = p.exit_code ?? "?";
    await dm(`:repeat: *Experiment retrying:* ${event.project}/${event.id} — attempt ${attempt}/${maxAttempts} (transient failure: exit code ${exitCode})`);
    return;
  }

  const icon = event.status === "completed" ? ":white_check_mark:" :
               event.status === "failed" ? ":x:" :
               event.status === "interrupted" ? ":stop_sign:" : ":grey_question:";
  const duration = p.duration_s ? `${p.duration_s}s` : "unknown";

  let text = `${icon} *Experiment ${event.status}:* ${event.project}/${event.id} (${duration})`;

  // Note if succeeded after retries
  if (event.status === "completed" && p.attempt && p.max_retries && p.max_retries > 0) {
    text += ` — succeeded on attempt ${p.attempt}/${p.max_retries + 1}`;
  }

  let logTail = "";
  if (event.status === "failed") {
    const error = p.error ?? `exit code ${p.exit_code ?? "?"}`;
    text += `\nError: ${error}`;
    if (p.failure_class === "transient_exhausted") {
      text += ` (failed after ${p.attempt ?? "?"} retries)`;
    }
    // Include last few lines of the log for immediate context
    const dir = p.experiment_dir ?? "";
    if (dir) {
      logTail = await tailLog(dir, 10);
      if (logTail && logTail !== "(no log file)" && logTail !== "(empty log)") {
        const truncated = logTail.length > 800 ? logTail.slice(-800) : logTail;
        text += `\n\`\`\`\n${truncated}\n\`\`\``;
      }
    }
  }

  if (event.status === "completed" && p.pct !== undefined) {
    text += ` — ${p.current ?? "?"}/${p.total ?? "?"} rows`;
  }

  const messageTs = await dm(text);

  // Auto-fix: when an experiment fails, spawn a diagnostic agent to investigate and fix
  // Reply in the same thread as the failure notification
  if (event.status === "failed" && repoDir) {
    console.log(`[experiments] Triggering autofix for ${event.project}/${event.id} — error: ${p.error ?? 'unknown'}`);
    const dir = p.experiment_dir ?? `${repoDir}/projects/${event.project}/experiments/${event.id}`;
    const error = p.error ?? `exit code ${p.exit_code ?? "?"}`;

    autoFixExperiment({
      project: event.project,
      expId: event.id,
      experimentDir: dir,
      error,
      logTail,
      repoDir,
      onMessage: (msg) => messageTs ? dmThread(messageTs, msg) : dm(msg).then(() => {}),
    }).catch((err) => {
      console.error(`[autofix] Unhandled error:`, err);
    });
  }
}

// --- Watch forwarder (throttled message delivery to Slack threads) ---

/** Pending messages per watcher key, flushed on an interval. */
const watchBuffers = new Map<string, { channel: string; threadTs: string; messages: BufferedMessage[] }>();

function setupWatchForwarder(): void {
  setWatchCallback((sessionId, msg) => {
    const session = getSession(sessionId);
    if (!session) return;

    // If living message is enabled, update it instead of buffering
    if (isLivingMessageEnabled() && app) {
      // Result messages indicate the session is completing — finalize immediately
      // while session data is still available (before executor cleanup)
      if (msg.kind === "result") {
        const isError = msg.text.startsWith("[error]");
        finalizeLivingMessage(app.client, sessionId, {
          state: isError ? "failed" : "complete",
          costUsd: session.costUsd,
          turnCount: session.numTurns,
          error: isError ? msg.text : undefined,
        }).catch((err) => {
          console.error(`[slack] Failed to finalize living message on result:`, err);
        });
        return;
      }

      const lm = findLivingMessage(sessionId);
      if (lm) {
        // Determine what to show as the main status line.
        // Priority: tool commands > tool results > reasoning text > generic.
        let activity: string;
        if (msg.kind === "assistant") {
          const lines = msg.text.split("\n");
          const toolLines = lines.filter(l => l.startsWith("[tool:"));
          if (toolLines.length > 0) {
            // Show actual tool commands as the main status (e.g., "bash: npm test")
            activity = toolLines.map(l => l.replace(/^\[tool:\s*/, "").replace(/\]$/, "")).join(", ");
          } else {
            // No tool blocks — show reasoning text
            activity = inferActivity(msg);
          }
        } else if (msg.kind === "tool") {
          // Tool result summaries (from summarizeMessage's tool_use_summary path)
          activity = msg.text.length > 120 ? msg.text.slice(0, 120) + "..." : msg.text;
        } else {
          activity = inferActivity(msg);
        }
        scheduleLivingMessageUpdate(app.client, sessionId, {
          lastActivity: activity,
          turnCount: session.numTurns,
          costUsd: session.costUsd,
        });
      } else {
        // First message for this session — create the living message
        for (const watchKey of session.watchers) {
          if (channelConvKeys.has(watchKey)) continue;
          const [channel, threadTs] = watchKey.split(":");
          if (!channel || !threadTs) continue;
          createLivingMessage({
            client: app.client,
            channel,
            threadTs,
            sessionId,
            maxTurns: null, // maxTurns not tracked in current session.ts
          }).catch((err) => {
            console.error(`[slack] Failed to create living message:`, err);
          });
        }
      }
      return;
    }

    // Legacy mode: buffer messages for periodic posting
    for (const watchKey of session.watchers) {
      if (channelConvKeys.has(watchKey)) continue;
      const [channel, threadTs] = watchKey.split(":");
      if (!channel || !threadTs) continue;

      let buf = watchBuffers.get(watchKey);
      if (!buf) {
        buf = { channel, threadTs, messages: [] };
        watchBuffers.set(watchKey, buf);
      }
      buf.messages.push(msg);
    }
  });

  // Flush every 3 seconds (only used in legacy mode when SLACK_LIVING_MESSAGE != 1)
  setInterval(() => {
    if (!isLivingMessageEnabled()) {
      flushWatchBuffers();
    }
  }, 3000);
}

function flushWatchBuffers(): void {
  if (!app) return;

  for (const [key, buf] of watchBuffers) {
    if (buf.messages.length === 0) continue;

    const messages = buf.messages.splice(0); // drain
    let text = "";
    for (const m of messages) {
      const prefix = m.kind === "result" ? ":checkered_flag: " : "";
      const line = m.text.split("\n")[0]; // first line only for watch
      const truncated = line.length > 200 ? line.slice(0, 200) + "..." : line;
      text += `${prefix}${truncated}\n`;
    }

    if (text) {
      app.client.chat.postMessage({
        channel: buf.channel,
        thread_ts: buf.threadTs,
        text: text.trim(),
      }).catch((err) => {
        console.error(`[slack] Watch post failed for ${key}:`, err);
        watchBuffers.delete(key);
      });
    }
  }
}

// --- Fleet notification batching ---

/** Buffer for fleet worker completions (successes only; failures are immediate). */
const fleetCompletionBuffer: FleetWorkerResult[] = [];

/** Fleet completion buffer flush interval. Defaults to 2 hours. */
const FLEET_FLUSH_INTERVAL_MS = parseInt(process.env.FLEET_FLUSH_INTERVAL_MS ?? "7200000", 10);

/** Post a fleet completion notification.
 *  Failures are posted immediately; successes are batched for periodic digest. */
export async function notifyFleetCompletion(result: FleetWorkerResult): Promise<void> {
  if (!app) return;

  if (!result.ok) {
    // Immediate notification for failures
    const durationSec = Math.round(result.durationMs / 1000);
    const text = `:blue_car: :x: Fleet task failed: *${result.taskId}* (${result.project})\n` +
      `Duration: ${durationSec}s` +
      (result.error ? `\nError: ${result.error.slice(0, 200)}` : '');
    await dm(text);
  } else {
    // Buffer success for periodic digest
    fleetCompletionBuffer.push(result);
  }
}

/** Post an immediate fleet escalation notification. */
export async function notifyFleetEscalation(
  taskId: string,
  project: string,
  reason: string
): Promise<void> {
  if (!app) return;

  const text = `:blue_car: :warning: Fleet escalation: *${taskId}* (${project}) needs Opus\n` +
    `Reason: ${reason}`;
  await dm(text);
}

/** Post a fleet drain notification (started or completed). */
export async function notifyFleetDrain(
  phase: "started" | "completed",
  activeCount: number,
  reason: string
): Promise<void> {
  if (!app) return;

  if (phase === "started") {
    const text = `:blue_car: :stop_sign: Fleet drain started\n` +
      `Active workers: ${activeCount}\n` +
      `Reason: ${reason}`;
    await dm(text);
  } else {
    const text = `:blue_car: :white_check_mark: Fleet drain completed\n` +
      `Drained: ${activeCount} worker(s)\n` +
      `Reason: ${reason}`;
    await dm(text);
  }
}

/** Post a fleet starvation alert when no tasks are available (core task supply, ADR 0053).
 *  Throttled by the caller (FleetScheduler) to once per 30 minutes.
 *  Includes decomposable task suggestions when available. */
export async function notifyFleetStarvation(
  fleetSize: number,
  totalTasksScanned: number,
  decomposableTasks?: Array<{ text: string; project: string; trigger: string }>,
): Promise<void> {
  if (!app) return;

  const lines = [
    `:blue_car: :warning: *Fleet starvation* — 0 decomposed tasks available`,
    `Fleet size: ${fleetSize} workers (using idle exploration — idle fallback)`,
    `Tasks scanned: ${totalTasksScanned} (all blocked, in-progress, or requires-frontier)`,
  ];

  if (decomposableTasks && decomposableTasks.length > 0) {
    lines.push("");
    lines.push(`*${decomposableTasks.length} requires-frontier task(s) could be decomposed into decomposed subtasks:*`);
    for (const t of decomposableTasks.slice(0, 5)) {
      const truncated = t.text.length > 70 ? t.text.slice(0, 67) + "..." : t.text;
      lines.push(`  • \`${t.project}\`: ${truncated} _(${t.trigger})_`);
    }
    lines.push(`_Next Opus session: decompose these tasks per ADR 0053._`);
  } else {
    lines.push(`Workers are running idle exploration (horizon scans, audits, open questions) until new tasks are available.`);
    lines.push(`_Create decomposed tasks to resume directed work — see core task supply._`);
  }

  await dm(lines.join("\n"));
}

/** Post a low utilization alert when rolling 1-hour utilization drops below target (ADR 0054).
 *  Throttled by the caller (FleetScheduler) to once per hour. */
export async function notifyFleetLowUtilization(
  utilization: number,
  reason: "no-tasks" | "all-claimed" | "all-on-cooldown",
  fleetSize: number,
  activeWorkers: number,
): Promise<void> {
  if (!app) return;

  const percent = (utilization * 100).toFixed(1);
  const reasonDescriptions: Record<string, string> = {
    "no-tasks": "No decomposed tasks available",
    "all-claimed": "All available tasks already claimed by active workers",
    "all-on-cooldown": "All candidate tasks on cooldown (zero-output or failure)",
  };

  const lines = [
    `:blue_car: :chart_with_downwards_trend: *Low fleet utilization* — ${percent}% (target: 75%)`,
    `Fleet size: ${fleetSize} | Active: ${activeWorkers}`,
    `Top idle reason: ${reasonDescriptions[reason]}`,
    `_See ADR 0054 for utilization tracking methodology._`,
  ];

  await dm(lines.join("\n"));
}

/** Flush the fleet completion buffer and post a digest. */
function flushFleetCompletions(): void {
  if (!app || fleetCompletionBuffer.length === 0) return;

  const results = fleetCompletionBuffer.splice(0); // drain
  const completed = results.length;
  const totalCost = results.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  const totalTurns = results.reduce((sum, r) => sum + (r.numTurns || 0), 0);
  const avgDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0) / completed;

  const taskResults = results.filter(r => !r.isIdle);
  const idleResults = results.filter(r => r.isIdle);

  const lines: string[] = [];
  lines.push(`:blue_car: Fleet digest: ${completed} session${completed === 1 ? '' : 's'} completed`);

  if (taskResults.length > 0) {
    lines.push(`Tasks: ${taskResults.length} completed`);
  }
  if (idleResults.length > 0) {
    const idleWithCommits = idleResults.filter(r => r.verification?.hasCommit);
    lines.push(`Idle exploration: ${idleResults.length} sessions (${idleWithCommits.length} produced findings)`);
  }

  lines.push(`Total cost: $${totalCost.toFixed(2)} | Turns: ${totalTurns} | Avg duration: ${Math.round(avgDurationMs / 1000)}s`);

  dm(lines.join("\n")).catch((err) => {
    console.error(`[slack] Fleet digest post failed:`, err);
  });
}

/** Start the fleet completion flush interval. */
function startFleetFlushInterval(): void {
  setInterval(() => {
    flushFleetCompletions();
  }, FLEET_FLUSH_INTERVAL_MS);
}

/** Post a fleet status report to Slack DM.
 *  Called periodically from the service tick (e.g., every 30 minutes when fleet is active). */
export async function notifyFleetStatus(scheduler: FleetScheduler): Promise<void> {
  if (!app) return;
  const snap = scheduler.getStatusSnapshot();
  // Only report when fleet is enabled and has had activity
  if (snap.maxWorkers === 0) return;
  if (snap.totalLaunched === 0 && snap.activeCount === 0) return;
  const report = formatFleetStatusReport(snap);
  await dm(report);
}

/** Infer activity description from a buffered message.
 *  Extracts actual content (command text, file paths, agent reasoning) instead of generic labels. */
function inferActivity(msg: BufferedMessage): string {
  if (msg.kind === "result") return "finishing...";

  // Tool messages already have good summaries from summarizeMessage()
  if (msg.kind === "tool") {
    return msg.text.length > 120 ? msg.text.slice(0, 120) + "..." : msg.text;
  }

  // Assistant messages: extract actual text content for display
  if (msg.kind === "assistant") {
    const lines = msg.text.split("\n");
    const textLines = lines.filter(l => !l.startsWith("[tool:"));
    const toolLines = lines.filter(l => l.startsWith("[tool:"));

    // Show the agent's actual reasoning/explanation text
    if (textLines.length > 0 && textLines[0].trim()) {
      const text = textLines[0].trim();
      return text.length > 120 ? text.slice(0, 120) + "..." : text;
    }
    // If only tool blocks, summarize the tool names and details
    if (toolLines.length > 0) {
      const summary = toolLines.map(l => l.replace(/^\[tool:\s*/, "").replace(/\]$/, "")).join(", ");
      return summary.length > 120 ? summary.slice(0, 120) + "..." : summary;
    }
  }

  return "working...";
}

// --- Thread history formatting ---

const MAX_THREAD_CHARS = 12_000;

/** Format Slack thread messages into a text block for the chat agent's prompt.
 *  Truncates older messages if the thread is very long, keeping the most recent.
 *  When userNames map is provided, non-bot messages from known users show their display name. */
export function formatThreadMessages(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[],
  humanUserId?: string,
  userNames?: Map<string, string>,
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const text = (msg.text ?? "").trim();
    if (!text) continue;

    const ts = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString().slice(11, 19) : "??:??";
    const isBot = !!msg.bot_id;
    const msgUser: string | undefined = msg.user;
    let sender: string;
    if (isBot) {
      sender = "Bot";
    } else if (msgUser && userNames?.has(msgUser)) {
      sender = userNames.get(msgUser)!;
    } else if (msgUser && msgUser === humanUserId) {
      sender = "User";
    } else {
      sender = "User";
    }

    // Truncate individual messages that are very long (e.g., full deep work output)
    const truncated = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
    lines.push(`[${ts}] ${sender}: ${truncated}`);
  }

  // If total is too large, keep the first few and the most recent messages
  let result = lines.join("\n");
  if (result.length > MAX_THREAD_CHARS) {
    const header = lines.slice(0, 3).join("\n");
    const tail = lines.slice(-20).join("\n");
    result = header + "\n...(earlier messages truncated)...\n" + tail;
    if (result.length > MAX_THREAD_CHARS) {
      result = result.slice(-MAX_THREAD_CHARS);
    }
  }

  return result;
}
