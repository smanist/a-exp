/** Type definitions for the reporting system. */

import type { ChartConfiguration } from "chart.js";

// ── Report types and formats ────────────────────────────────────────────────

export type ReportType = "operational" | "research" | "project" | "experiment-comparison";
export type OutputFormat = "markdown" | "slack" | "html";

// ── Chart specification ─────────────────────────────────────────────────────

export interface ChartSpec {
  id: string;
  title: string;
  config: ChartConfiguration;
  width?: number;
  height?: number;
}

// ── Session data ────────────────────────────────────────────────────────────

export interface DaySummary {
  date: string;
  sessions: number;
  successes: number;
  failures: number;
  totalCostUsd: number;
  totalDurationMs: number;
  avgTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
}

export interface SessionSummary {
  totalSessions: number;
  successRate: number;
  totalCostUsd: number;
  avgCostPerSession: number;
  avgDurationMs: number;
  avgTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  avgTotalTokensPerSession: number;
  byDay: DaySummary[];
}

// ── Budget data ─────────────────────────────────────────────────────────────

export interface BudgetSummary {
  project: string;
  resources: {
    resource: string;
    consumed: number;
    limit: number;
    unit: string;
    pct: number;
  }[];
  deadline?: string;
  hoursToDeadline?: number;
  /** Projected exhaustion date based on current burn rate, or null if no consumption. */
  projectedExhaustion?: string | null;
}

// ── Experiment data ─────────────────────────────────────────────────────────

export interface ExperimentRecord {
  id: string;
  project: string;
  type: string;
  status: string;
  date: string;
  tags: string[];
  consumesResources: boolean;
  findingsCount: number;
  title: string;
  path: string;
}

// ── Project data ────────────────────────────────────────────────────────────

export interface ProjectTask {
  text: string;
  done: boolean;
  tags: string[];
}

export interface LogEntry {
  date: string;
  content: string;
}

export interface ProjectSummary {
  name: string;
  status: string;
  mission: string;
  doneWhen: string;
  logEntries: LogEntry[];
  tasks: ProjectTask[];
  openQuestions: string[];
  budget?: BudgetSummary;
  experiments: ExperimentRecord[];
}

// ── Knowledge data ──────────────────────────────────────────────────────────

export interface KnowledgeSummary {
  totalExperiments: number;
  completedExperiments: number;
  totalFindings: number;
  decisionRecords: number;
  /** Findings per completed experiment. */
  avgFindingsPerExperiment: number;
}

// ── Efficiency data ────────────────────────────────────────────────────────

export interface EfficiencyDaySummary {
  date: string;
  sessions: number;
  totalFindings: number;
  totalCostUsd: number;
  findingsPerDollar: number;
  zeroKnowledgeSessions: number;
}

export interface FleetEfficiencySummary {
  totalSessions: number;
  /** Fraction of fleet sessions that completed their task (verification.hasCommit). */
  taskCompletionRate: number;
  /** Fraction of fleet sessions that passed verification (hasCommit && hasLogEntry). */
  verificationPassRate: number;
  /** Fraction of fleet sessions with a log entry (verification.hasLogEntry). */
  logEntryRate: number;
  /** Average commits per fleet session (agent commits, excluding scheduler auto-commits). */
  avgCommitsPerSession: number;
  /** Fraction of fleet sessions that produced any knowledge output. */
  knowledgeProductionRate: number;
  /** Average files changed per fleet session. */
  avgFilesChanged: number;
}

export interface EfficiencySummary {
  totalSessions: number;
  findingsPerDollar: number;
  avgCostPerFinding: number;
  avgTurnsPerFinding: number;
  zeroKnowledgeRate: number;
  genuineWasteRate: number;
  /** Fraction of sessions with context utilization >= 80% warning threshold. */
  highContextUtilizationRate: number;
  /** Maximum context utilization observed across all sessions (0-1). */
  maxContextUtilization: number;
  byDay: EfficiencyDaySummary[];
  /** Fleet-specific efficiency metrics. Null if no fleet sessions in period. */
  fleet: FleetEfficiencySummary | null;
}

// ── Aggregated report data ──────────────────────────────────────────────────

export interface ReportData {
  generatedAt: string;
  period: { from: string; to: string };
  sessions: SessionSummary;
  budgets: BudgetSummary[];
  experiments: ExperimentRecord[];
  projects: ProjectSummary[];
  knowledge: KnowledgeSummary;
  efficiency: EfficiencySummary;
}

// ── Report options ──────────────────────────────────────────────────────────

export interface ReportOptions {
  type: ReportType;
  format: OutputFormat;
  repoDir: string;
  metricsPath?: string;
  /** ISO date string — start of period. Defaults to 7 days ago. */
  periodFrom?: string;
  /** ISO date string — end of period. Defaults to now. */
  periodTo?: string;
  /** Project name filter (for project/experiment-comparison reports). */
  project?: string;
  /** Experiment IDs to compare (for experiment-comparison reports). */
  experimentIds?: string[];
}

export interface ReportResult {
  content: string;
  charts: { id: string; buffer: Buffer }[];
}
