/** Type definitions for the akari scheduler. Minimal extraction from OpenClaw cron types. */

import type { BackendCapability } from "./backend.js";

export interface CronSchedule {
  kind: "cron";
  /** 5-field cron expression (minute hour day month weekday) */
  expr: string;
  /** IANA timezone; missing values from older jobs are treated as UTC */
  tz?: string;
}

export interface IntervalSchedule {
  kind: "every";
  /** Interval in milliseconds */
  everyMs: number;
  /** Anchor timestamp in ms (defaults to job creation time) */
  anchorMs?: number;
}

export type Schedule = CronSchedule | IntervalSchedule;

export type TaskType = "experiment" | "analysis" | "implementation" | "bugfix";

export interface JobPayload {
  /** Message to send to the agent */
  message: string;
  /** Model to use (e.g. "opus", "sonnet") */
  model?: string;
  /** Reviewer model for isolated module review sessions. */
  reviewerModel?: string;
  /** Working directory for the agent session */
  cwd?: string;
  /** Backend capabilities required when auto-selecting a backend. */
  requiredCapabilities?: BackendCapability[];
  /** Maximum session duration in milliseconds. Default: 3,600,000 (60 min). */
  maxDurationMs?: number;
  /** Agent profile key from AGENT_PROFILES (e.g. "skillCycle"). Overrides model/maxDurationMs defaults. */
  profile?: string;
  /** Specialist role for this session (e.g. "project-researcher", "infrastructure-engineer", "synthesizer"). */
  role?: string;
  /** Project scope for specialist roles (e.g. "sample-project"). Used with role to scope orient. */
  roleProject?: string;
  /** Task type for convention module injection. Determines which schema/convention files are loaded. */
  taskType?: TaskType;
}

export interface JobState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runCount: number;
  /** Timestamp (ms) of the last session that ran a full /orient. Used for orient tiering (ADR 0030). */
  lastFullOrientAt?: number | null;
  /** Timestamp (ms) of the last session that ran a full /compound. Used for compound tiering. */
  lastFullCompoundAt?: number | null;
}

export interface Job {
  id: string;
  name: string;
  schedule: Schedule;
  payload: JobPayload;
  enabled: boolean;
  createdAtMs: number;
  state: JobState;
}

export interface JobCreate {
  name: string;
  schedule: Schedule;
  payload: JobPayload;
  enabled?: boolean;
}

export interface Store {
  version: 1;
  jobs: Job[];
}
