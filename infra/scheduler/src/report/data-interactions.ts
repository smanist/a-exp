/** Interaction analytics for reports — action frequency, fulfillment rates. */

import { readFile } from "node:fs/promises";
import type { InteractionRecord } from "../metrics.js";

export interface InteractionSummary {
  totalInteractions: number;
  byAction: Record<string, number>;
  byIntentType: Record<string, number>;
  fulfillmentRate: number;
  correctionRate: number;
  avgTurnsBeforeAction: number;
}

const DEFAULT_INTERACTIONS_PATH = new URL(
  "../../../../.scheduler/metrics/interactions.jsonl",
  import.meta.url,
).pathname;

/** Read and aggregate interaction records. */
export async function aggregateInteractions(
  since?: string,
  interactionsPath?: string,
): Promise<InteractionSummary> {
  const path = interactionsPath ?? DEFAULT_INTERACTIONS_PATH;
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return emptyResult();
  }

  let records = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as InteractionRecord);

  if (since) {
    records = records.filter((r) => r.timestamp >= since);
  }

  if (records.length === 0) return emptyResult();

  const byAction: Record<string, number> = {};
  const byIntentType: Record<string, number> = {};
  let fulfilledCount = 0;
  let correctedCount = 0;
  let turnsSum = 0;
  let turnsCount = 0;

  for (const r of records) {
    byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    if (r.intentType) byIntentType[r.intentType] = (byIntentType[r.intentType] ?? 0) + 1;
    if (r.intentFulfilled === "fulfilled") fulfilledCount++;
    if (r.userCorrected) correctedCount++;
    if (r.turnsBeforeAction != null) {
      turnsSum += r.turnsBeforeAction;
      turnsCount++;
    }
  }

  return {
    totalInteractions: records.length,
    byAction,
    byIntentType,
    fulfillmentRate: fulfilledCount / records.length,
    correctionRate: correctedCount / records.length,
    avgTurnsBeforeAction: turnsCount > 0 ? Math.round((turnsSum / turnsCount) * 10) / 10 : 0,
  };
}

function emptyResult(): InteractionSummary {
  return {
    totalInteractions: 0,
    byAction: {},
    byIntentType: {},
    fulfillmentRate: 0,
    correctionRate: 0,
    avgTurnsBeforeAction: 0,
  };
}
