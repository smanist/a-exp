/** Channel mode configuration for multi-channel Slack interactions (ADR 0033).
 *  Sources: env vars (SLACK_DEV_CHANNELS, SLACK_CHAT_CHANNELS) + persisted JSON file.
 *  Runtime additions via setChannelMode() persist to JSON; env vars take precedence on overlap. */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ChannelMode = "dev" | "chat";
export type Team = "art" | "product" | "engineering" | "research";

export interface ChannelConfigEntry {
  mode: ChannelMode;
  channelId: string;
  team?: Team;
}

interface PersistedChannelModes {
  channels: Record<string, ChannelMode | { mode: ChannelMode; team?: Team }>;
}

const channelMap = new Map<string, ChannelMode>();
const channelTeamMap = new Map<string, Team>();
let designatedUserId: string | null = null;

const DEFAULT_PERSIST_PATH = new URL(
  "../../../.scheduler/channel-modes.json",
  import.meta.url,
).pathname;

let persistPath: string | null = DEFAULT_PERSIST_PATH;

/** Override the persistence file path (for testing). Pass null to reset to default. */
export function setChannelModesPath(path: string | null): void {
  persistPath = path ?? DEFAULT_PERSIST_PATH;
}

/** Parse env vars, load persisted config, and populate the channel mode registry.
 *  Load order: persisted JSON first, then env vars (env vars win on overlap). */
export function initChannelModes(): void {
  designatedUserId = process.env["SLACK_USER_ID"] ?? null;
  channelMap.clear();
  channelTeamMap.clear();

  // Layer 1: persisted JSON file
  loadPersistedModes();

  // Layer 2: env vars (override persisted on overlap)
  const chatChannels = parseChannelList(process.env["SLACK_CHAT_CHANNELS"]);
  for (const id of chatChannels) {
    channelMap.set(id, "chat");
  }

  const devChannels = parseChannelList(process.env["SLACK_DEV_CHANNELS"]);
  for (const id of devChannels) {
    channelMap.set(id, "dev");
  }

  if (channelMap.size > 0) {
    const devCount = [...channelMap.values()].filter((m) => m === "dev").length;
    const chatCount = channelMap.size - devCount;
    console.log(`[channel-mode] Loaded ${channelMap.size} channel(s): ${devCount} dev, ${chatCount} chat`);
  }
}

function parseChannelList(envVal: string | undefined): string[] {
  if (!envVal) return [];
  return envVal.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Get the mode for a channel. Returns null for unregistered channels. */
export function getChannelMode(channelId: string): ChannelMode | null {
  return channelMap.get(channelId) ?? null;
}

/** Check if a user ID is the designated operator (SLACK_USER_ID). */
export function isDesignatedUser(userId: string): boolean {
  return !!designatedUserId && userId === designatedUserId;
}

/** Whether any channel configs exist. */
export function hasChannelConfigs(): boolean {
  return channelMap.size > 0;
}

/** List all configured channels with their modes. */
export function listChannelConfigs(): ChannelConfigEntry[] {
  return [...channelMap.entries()].map(([channelId, mode]) => ({
    mode,
    channelId,
    ...(channelTeamMap.has(channelId) && { team: channelTeamMap.get(channelId) }),
  }));
}

/** Set a channel's mode at runtime. Updates in-memory map and persists to JSON. */
export async function setChannelMode(
  channelId: string,
  mode: ChannelMode,
  team?: Team,
): Promise<void> {
  channelMap.set(channelId, mode);
  if (team) {
    channelTeamMap.set(channelId, team);
  } else {
    channelTeamMap.delete(channelId);
  }
  await persistChannelModes();
  console.log(`[channel-mode] Set ${channelId} → ${mode}${team ? ` (${team})` : ""}`);
}

/** Remove a channel from the registry. Returns true if the channel existed.
 *  Updates in-memory map and persists to JSON. */
export async function removeChannelMode(channelId: string): Promise<boolean> {
  const existed = channelMap.delete(channelId);
  channelTeamMap.delete(channelId);
  if (existed) {
    await persistChannelModes();
    console.log(`[channel-mode] Removed ${channelId}`);
  }
  return existed;
}

/** Get the team for a channel. Returns null for unregistered channels or channels without team. */
export function getChannelTeam(channelId: string): Team | null {
  return channelTeamMap.get(channelId) ?? null;
}

/** Load channel modes from the persisted JSON file into the in-memory map. */
function loadPersistedModes(): void {
  if (!persistPath) return;
  try {
    const raw = readFileSync(persistPath, "utf-8");
    const data = JSON.parse(raw) as PersistedChannelModes;
    if (data.channels && typeof data.channels === "object") {
      for (const [channelId, value] of Object.entries(data.channels)) {
        if (typeof value === "string") {
          if (value === "dev" || value === "chat") {
            channelMap.set(channelId, value);
          }
        } else if (typeof value === "object" && value !== null) {
          const entry = value as { mode: ChannelMode; team?: Team };
          if (entry.mode === "dev" || entry.mode === "chat") {
            channelMap.set(channelId, entry.mode);
            if (entry.team && ["art", "product", "engineering", "research"].includes(entry.team)) {
              channelTeamMap.set(channelId, entry.team);
            }
          }
        }
      }
    }
  } catch {
    // File doesn't exist or is invalid — normal on first run
  }
}

/** Persist current dynamically-added channel modes to the JSON file.
 *  Reads existing file first to avoid clobbering, then merges current in-memory state. */
async function persistChannelModes(): Promise<void> {
  if (!persistPath) return;
  const channels: Record<string, ChannelMode | { mode: ChannelMode; team?: Team }> = {};
  for (const [channelId, mode] of channelMap) {
    const team = channelTeamMap.get(channelId);
    if (team) {
      channels[channelId] = { mode, team };
    } else {
      channels[channelId] = mode;
    }
  }
  const data: PersistedChannelModes = { channels };
  try {
    mkdirSync(dirname(persistPath), { recursive: true });
    writeFileSync(persistPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error(`[channel-mode] Failed to persist: ${err}`);
  }
}
