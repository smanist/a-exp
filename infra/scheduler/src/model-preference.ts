/** Persistent model preference storage for Slack-driven sessions.
 *  Also imports legacy backend-preference files once and normalizes them into
 *  model-driven routing. */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";

interface PersistedModelPreference {
  model?: string;
}

interface PersistedLegacyBackendPreference {
  backend?: string;
}

let currentPreference: string | null = null;

const DEFAULT_MODEL_PREFERENCE_PATH = new URL(
  "../../../.scheduler/model-preference.json",
  import.meta.url,
).pathname;

const DEFAULT_LEGACY_BACKEND_PREFERENCE_PATH = new URL(
  "../../../.scheduler/backend-preference.json",
  import.meta.url,
).pathname;

let modelPreferencePath: string | null = DEFAULT_MODEL_PREFERENCE_PATH;
let legacyBackendPreferencePath: string | null = DEFAULT_LEGACY_BACKEND_PREFERENCE_PATH;

export function setModelPreferencePath(path: string | null): void {
  modelPreferencePath = path ?? DEFAULT_MODEL_PREFERENCE_PATH;
}

export function setLegacyBackendPreferencePath(path: string | null): void {
  legacyBackendPreferencePath = path ?? DEFAULT_LEGACY_BACKEND_PREFERENCE_PATH;
}

export function initModelPreference(): void {
  currentPreference = loadPersistedPreference();
  if (currentPreference) {
    console.log(`[model-preference] Loaded persisted preference: ${currentPreference}`);
  }
}

export function getModelPreference(): string | null {
  return currentPreference;
}

export async function setModelPreference(model: string): Promise<void> {
  currentPreference = model.trim() || null;
  await persistModelPreference();
  console.log(`[model-preference] Set model to ${currentPreference ?? "<default>"}`);
}

export async function clearModelPreference(): Promise<void> {
  currentPreference = null;
  await persistModelPreference();
  console.log("[model-preference] Cleared model preference");
}

function loadPersistedPreference(): string | null {
  const stored = loadModelPreferenceFile();
  if (stored) return stored;
  const migrated = loadLegacyBackendPreference();
  if (migrated !== undefined) {
    currentPreference = migrated;
    void persistModelPreference();
    removeLegacyBackendPreference();
    return migrated;
  }
  return null;
}

function loadModelPreferenceFile(): string | null {
  if (!modelPreferencePath) return null;
  try {
    const raw = readFileSync(modelPreferencePath, "utf-8");
    const data = JSON.parse(raw) as PersistedModelPreference;
    return typeof data.model === "string" && data.model.trim() ? data.model.trim() : null;
  } catch {
    return null;
  }
}

function loadLegacyBackendPreference(): string | null | undefined {
  if (!legacyBackendPreferencePath || !existsSync(legacyBackendPreferencePath)) return undefined;
  try {
    const raw = readFileSync(legacyBackendPreferencePath, "utf-8");
    const data = JSON.parse(raw) as PersistedLegacyBackendPreference;
    const backend = typeof data.backend === "string" ? data.backend.trim() : "";
    if (!backend) return null;
    // Legacy backend names now migrate to default model-driven routing.
    return null;
  } catch {
    return null;
  }
}

function removeLegacyBackendPreference(): void {
  if (!legacyBackendPreferencePath) return;
  try {
    if (existsSync(legacyBackendPreferencePath)) unlinkSync(legacyBackendPreferencePath);
  } catch (err) {
    console.warn(`[model-preference] Failed to remove legacy backend preference: ${err}`);
  }
}

async function persistModelPreference(): Promise<void> {
  if (!modelPreferencePath) return;
  const data: PersistedModelPreference = {
    model: currentPreference ?? undefined,
  };
  try {
    mkdirSync(dirname(modelPreferencePath), { recursive: true });
    writeFileSync(modelPreferencePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error(`[model-preference] Failed to persist: ${err}`);
  }
}
