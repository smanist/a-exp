export type { Job } from "../../src/types.js";

export interface FleetWorkerResult {
  taskId: string;
  project: string;
  sessionId: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  costUsd?: number;
  numTurns?: number;
  timedOut?: boolean;
  isIdle?: boolean;
  verification?: {
    hasCommit?: boolean;
    hasLogEntry?: boolean;
  } | null;
}
