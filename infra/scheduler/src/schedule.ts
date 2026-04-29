/** Compute next run time for a schedule. Uses croner for cron expression parsing. */

import { Cron } from "croner";
import type { Schedule } from "./types.js";

export function computeNextRunAtMs(
  schedule: Schedule,
  nowMs: number,
): number | null {
  if (schedule.kind === "cron") {
    const cron = new Cron(schedule.expr, { timezone: schedule.tz ?? "UTC" });
    // Get next occurrence strictly after now (avoid re-trigger on same second)
    const nowDate = new Date(nowMs);
    nowDate.setMilliseconds(0);
    const next = cron.nextRun(new Date(nowDate.getTime() + 1000));
    return next ? next.getTime() : null;
  }

  if (schedule.kind === "every") {
    const anchor = schedule.anchorMs ?? nowMs;
    const elapsed = nowMs - anchor;
    const intervals = Math.floor(elapsed / schedule.everyMs);
    const next = anchor + (intervals + 1) * schedule.everyMs;
    return next;
  }

  return null;
}
