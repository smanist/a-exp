/** Scheduled report generation — runs on cron, posts directly to Slack. */

import { gatherReportData } from "./aggregator.js";
import {
  renderOperationalSlack,
  renderResearchSlack,
} from "./render-slack.js";
import type { ReportType } from "./types.js";

type PostBlocksFn = (blocks: unknown[], fallbackText: string) => Promise<void>;

/** Run a scheduled report: gather data, render to Block Kit, post to Slack.
 *  Designed to be called from service.ts onTick without spawning an agent session. */
export async function runScheduledReport(
  type: ReportType,
  repoDir: string,
  postBlocks: PostBlocksFn,
): Promise<void> {
  const data = await gatherReportData(repoDir);

  let blocks: Record<string, unknown>[];
  let fallback: string;

  switch (type) {
    case "operational":
      blocks = renderOperationalSlack(data);
      fallback = `Operational report: ${data.sessions.totalSessions} sessions, $${data.sessions.totalCostUsd.toFixed(2)} cost`;
      break;
    case "research":
      blocks = renderResearchSlack(data);
      fallback = `Research digest: ${data.knowledge.totalFindings} findings, ${data.knowledge.completedExperiments} completed experiments`;
      break;
    default:
      console.log(`[scheduled-report] Skipping unsupported type for scheduled: ${type}`);
      return;
  }

  await postBlocks(blocks, fallback);
  console.log(`[scheduled-report] Posted ${type} report to Slack`);
}

/** Check if a cron expression matches the current time (minute granularity).
 *  Supports: "HH:MM" (daily) or day-of-week prefix "DOW HH:MM" (weekly).
 *  Examples: "09:00", "Mon 09:00" */
export function shouldRunReport(cronExpr: string, now: Date): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  const hhmm = parts.length > 1 ? parts[1] : parts[0];
  const [h, m] = hhmm.split(":").map(Number);

  if (now.getUTCHours() !== h || now.getUTCMinutes() !== m) return false;

  if (parts.length > 1) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayName = days[now.getUTCDay()];
    if (dayName !== parts[0]) return false;
  }

  return true;
}
