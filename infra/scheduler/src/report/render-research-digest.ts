/** Research digest renderer — what the institute learned in a period. */

import type { ReportData, ChartSpec } from "./types.js";
import { experimentStatusChart, knowledgeOutputChart } from "./chart-specs.js";

export function renderResearchDigestMarkdown(data: ReportData): { content: string; charts: ChartSpec[] } {
  const charts: ChartSpec[] = [];

  const lines: string[] = [
    `# Research Digest`,
    ``,
    `Period: ${data.period.from} to ${data.period.to}`,
    `Generated: ${data.generatedAt.slice(0, 16).replace("T", " ")} UTC`,
    ``,
    `## Knowledge Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total experiments | ${data.knowledge.totalExperiments} |`,
    `| Completed experiments | ${data.knowledge.completedExperiments} |`,
    `| Total findings | ${data.knowledge.totalFindings} |`,
    `| Decision records | ${data.knowledge.decisionRecords} |`,
    `| Avg findings/experiment | ${data.knowledge.avgFindingsPerExperiment} |`,
    ``,
  ];

  // Experiment status breakdown
  if (data.experiments.length > 0) {
    charts.push(experimentStatusChart(data));
    lines.push(`![Experiments by status](charts/experiment-status.png)`, ``);

    charts.push(knowledgeOutputChart(data));
    lines.push(`![Findings by project](charts/knowledge-output.png)`, ``);
  }

  // Recent completed experiments
  const completed = data.experiments
    .filter((e) => e.status === "completed")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);

  if (completed.length > 0) {
    lines.push(
      `## Recently Completed Experiments`,
      ``,
      `| Date | Project | Experiment | Findings | Type |`,
      `|------|---------|------------|----------|------|`,
    );
    for (const e of completed) {
      lines.push(`| ${e.date} | ${e.project} | ${e.id} | ${e.findingsCount} | ${e.type} |`);
    }
    lines.push(``);
  }

  // Experiments in progress
  const inProgress = data.experiments.filter((e) => e.status === "running" || e.status === "planned");
  if (inProgress.length > 0) {
    lines.push(`## Experiment Pipeline`, ``);
    for (const e of inProgress) {
      const icon = e.status === "running" ? "🔬" : "📋";
      lines.push(`- ${icon} **${e.id}** (${e.project}) — ${e.status} — ${e.title}`);
    }
    lines.push(``);
  }

  // Key findings from recent experiments
  const withFindings = completed.filter((e) => e.findingsCount > 0);
  if (withFindings.length > 0) {
    lines.push(`## Key Findings Overview`, ``);
    for (const e of withFindings.slice(0, 5)) {
      lines.push(`### ${e.id} (${e.project})`, ``);
      lines.push(`${e.findingsCount} findings documented. See \`${e.path}/EXPERIMENT.md\` for details.`, ``);
    }
  }

  return { content: lines.join("\n"), charts };
}
