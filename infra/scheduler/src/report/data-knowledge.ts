/** Knowledge metrics aggregation — cross-reference experiments with session data. */

import type { ExperimentRecord, KnowledgeSummary } from "./types.js";

/** Compute knowledge summary from experiment records. */
export function aggregateKnowledge(experiments: ExperimentRecord[]): KnowledgeSummary {
  const completed = experiments.filter((e) => e.status === "completed");
  const totalFindings = experiments.reduce((sum, e) => sum + e.findingsCount, 0);

  return {
    totalExperiments: experiments.length,
    completedExperiments: completed.length,
    totalFindings,
    decisionRecords: 0, // filled by aggregator from filesystem scan
    avgFindingsPerExperiment: completed.length > 0
      ? Math.round((totalFindings / completed.length) * 10) / 10
      : 0,
  };
}
