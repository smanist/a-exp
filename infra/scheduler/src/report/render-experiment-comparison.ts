/** Experiment comparison renderer — side-by-side parameter diffs and outcome comparison. */

import type { ReportData, ChartSpec } from "./types.js";
import { experimentComparisonChart } from "./chart-specs.js";

export function renderExperimentComparisonMarkdown(
  data: ReportData,
  experimentIds?: string[],
): { content: string; charts: ChartSpec[] } {
  const charts: ChartSpec[] = [];

  const experiments = experimentIds
    ? data.experiments.filter((e) => experimentIds.includes(e.id))
    : data.experiments.filter((e) => e.status === "completed");

  const lines: string[] = [
    `# Experiment Comparison`,
    ``,
    `Generated: ${data.generatedAt.slice(0, 16).replace("T", " ")} UTC`,
    ``,
  ];

  if (experiments.length === 0) {
    lines.push(`No experiments found for comparison.`);
    return { content: lines.join("\n"), charts };
  }

  // Comparison chart
  const compChart = experimentComparisonChart(experiments);
  if (compChart) {
    charts.push(compChart);
    lines.push(`![Experiment comparison](charts/experiment-comparison.png)`, ``);
  }

  // Summary table
  lines.push(
    `## Overview`,
    ``,
    `| Experiment | Project | Type | Status | Date | Findings | Resources |`,
    `|------------|---------|------|--------|------|----------|-----------|`,
  );
  for (const e of experiments) {
    lines.push(
      `| ${e.id} | ${e.project} | ${e.type} | ${e.status} | ${e.date} | ${e.findingsCount} | ${e.consumesResources ? "yes" : "no"} |`,
    );
  }
  lines.push(``);

  // Group by project
  const byProject = new Map<string, typeof experiments>();
  for (const e of experiments) {
    const arr = byProject.get(e.project) ?? [];
    arr.push(e);
    byProject.set(e.project, arr);
  }

  for (const [project, exps] of byProject) {
    lines.push(`## ${project}`, ``);

    for (const e of exps) {
      lines.push(`### ${e.id}`, ``);
      lines.push(`- **Type**: ${e.type}`);
      lines.push(`- **Status**: ${e.status}`);
      lines.push(`- **Date**: ${e.date}`);
      lines.push(`- **Findings**: ${e.findingsCount}`);
      if (e.tags.length > 0) {
        lines.push(`- **Tags**: ${e.tags.join(", ")}`);
      }
      lines.push(`- **Path**: \`${e.path}/EXPERIMENT.md\``);
      lines.push(``);
    }
  }

  return { content: lines.join("\n"), charts };
}
