/** Report data aggregator — combines all readers into a single ReportData object. */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readMetrics } from "../metrics.js";
import { aggregateSessions } from "./data-sessions.js";
import { readBudgets } from "./data-budget.js";
import { scanExperiments } from "./data-experiments.js";
import { readProjects } from "./data-projects.js";
import { aggregateKnowledge } from "./data-knowledge.js";
import { aggregateEfficiency } from "./data-efficiency.js";
import type { ReportData } from "./types.js";

/** Gather all report data from the repository. */
export async function gatherReportData(
  repoDir: string,
  periodFrom?: string,
  periodTo?: string,
  metricsPath?: string,
): Promise<ReportData> {
  const now = new Date();
  const from = periodFrom ?? new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const to = periodTo ?? now.toISOString().slice(0, 10);

  // Read all data sources in parallel
  const [sessions, budgets, experiments, projects] = await Promise.all([
    readMetrics({ since: from + "T00:00:00Z", metricsPath }),
    readBudgets(repoDir),
    scanExperiments(repoDir),
    readProjects(repoDir),
  ]);

  const sessionSummary = aggregateSessions(sessions);
  const knowledge = aggregateKnowledge(experiments);
  const efficiency = aggregateEfficiency(sessions);

  // Count decision records
  try {
    const decisionFiles = await readdir(join(repoDir, "decisions"));
    knowledge.decisionRecords = decisionFiles.filter((f) => f.match(/^\d{4}-.+\.md$/)).length;
  } catch {
    // no historical decision directory
  }

  return {
    generatedAt: now.toISOString(),
    period: { from, to },
    sessions: sessionSummary,
    budgets,
    experiments,
    projects,
    knowledge,
    efficiency,
  };
}
