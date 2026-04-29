/** Project status renderer — per-project health, tasks, budget, experiments. */

import type { ReportData, ChartSpec } from "./types.js";
import { budgetGaugeChart } from "./chart-specs.js";

export function renderProjectStatusMarkdown(
  data: ReportData,
  projectFilter?: string,
): { content: string; charts: ChartSpec[] } {
  const charts: ChartSpec[] = [];
  const projects = projectFilter
    ? data.projects.filter((p) => p.name === projectFilter)
    : data.projects;

  const lines: string[] = [
    `# Project Status`,
    ``,
    `Generated: ${data.generatedAt.slice(0, 16).replace("T", " ")} UTC`,
    ``,
  ];

  if (projects.length === 0) {
    lines.push(`No projects found${projectFilter ? ` matching "${projectFilter}"` : ""}.`);
    return { content: lines.join("\n"), charts };
  }

  for (const p of projects) {
    const statusIcon = p.status === "active" ? "🟢" : p.status === "paused" ? "🟡" : "✅";
    lines.push(`## ${statusIcon} ${p.name}`, ``);
    lines.push(`**Status:** ${p.status}`);
    if (p.mission) lines.push(`**Mission:** ${p.mission}`);
    if (p.doneWhen) lines.push(`**Done when:** ${p.doneWhen}`);
    lines.push(``);

    // Budget
    if (p.budget) {
      charts.push(budgetGaugeChart(p.budget));
      lines.push(`### Budget`, ``);
      lines.push(`![Budget: ${p.name}](charts/budget-${p.name}.png)`, ``);
      for (const r of p.budget.resources) {
        const bar = progressBar(r.pct);
        lines.push(`- **${r.resource}**: ${r.consumed}/${r.limit} ${r.unit} ${bar} ${r.pct}%`);
      }
      if (p.budget.deadline) {
        const remaining = p.budget.hoursToDeadline != null
          ? p.budget.hoursToDeadline <= 0 ? "PASSED" : `${p.budget.hoursToDeadline}h remaining`
          : "";
        lines.push(`- **Deadline**: ${p.budget.deadline} (${remaining})`);
      }
      lines.push(``);
    }

    // Tasks
    const openTasks = p.tasks.filter((t) => !t.done);
    const doneTasks = p.tasks.filter((t) => t.done);
    if (p.tasks.length > 0) {
      lines.push(`### Tasks (${doneTasks.length}/${p.tasks.length} done)`, ``);
      for (const t of openTasks.slice(0, 15)) {
        const tags = t.tags.length > 0 ? ` ${t.tags.join(" ")}` : "";
        lines.push(`- [ ] ${t.text}${tags}`);
      }
      if (openTasks.length > 15) {
        lines.push(`- ... and ${openTasks.length - 15} more`);
      }
      lines.push(``);
    }

    // Open questions
    if (p.openQuestions.length > 0) {
      lines.push(`### Open Questions`, ``);
      for (const q of p.openQuestions) {
        lines.push(`- ${q}`);
      }
      lines.push(``);
    }

    // Experiments
    if (p.experiments.length > 0) {
      const expCompleted = p.experiments.filter((e) => e.status === "completed").length;
      lines.push(`### Experiments (${expCompleted}/${p.experiments.length} completed)`, ``);
      lines.push(`| ID | Status | Date | Findings |`);
      lines.push(`|----|--------|------|----------|`);
      for (const e of p.experiments.slice(0, 10)) {
        lines.push(`| ${e.id} | ${e.status} | ${e.date} | ${e.findingsCount} |`);
      }
      if (p.experiments.length > 10) {
        lines.push(`| ... | ${p.experiments.length - 10} more | | |`);
      }
      lines.push(``);
    }

    // Recent log entries
    if (p.logEntries.length > 0) {
      lines.push(`### Recent Log Entries`, ``);
      for (const entry of p.logEntries.slice(0, 3)) {
        // Show just the first line of the content as summary
        const firstLine = entry.content.split("\n")[0].replace(/^###\s*/, "");
        lines.push(`- **${entry.date}**: ${firstLine.slice(0, 100)}`);
      }
      lines.push(``);
    }

    lines.push(`---`, ``);
  }

  return { content: lines.join("\n"), charts };
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "[" + "#".repeat(filled) + "-".repeat(10 - filled) + "]";
}
