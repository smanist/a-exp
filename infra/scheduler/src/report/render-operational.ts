/** Operational report renderer — session health, cost, budget burn. */

import type { ReportData, ChartSpec } from "./types.js";
import { sessionCostChart, sessionsPerDayChart, budgetGaugeChart, findingsPerDollarChart, zeroKnowledgeRateChart } from "./chart-specs.js";

function formatTokenCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function renderOperationalMarkdown(data: ReportData): { content: string; charts: ChartSpec[] } {
  const s = data.sessions;
  const charts: ChartSpec[] = [];

  const lines: string[] = [
    `# Operational Report`,
    ``,
    `Period: ${data.period.from} to ${data.period.to}`,
    `Generated: ${data.generatedAt.slice(0, 16).replace("T", " ")} UTC`,
    ``,
    `## Session Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total sessions | ${s.totalSessions} |`,
    `| Success rate | ${(s.successRate * 100).toFixed(1)}% |`,
    `| Total cost | $${s.totalCostUsd.toFixed(2)} |`,
    `| Avg cost/session | $${s.avgCostPerSession.toFixed(2)} |`,
    `| Avg duration | ${Math.round(s.avgDurationMs / 60000)} min |`,
    `| Avg turns | ${s.avgTurns} |`,
    `| Total input tokens | ${formatTokenCount(s.totalInputTokens)} |`,
    `| Total output tokens | ${formatTokenCount(s.totalOutputTokens)} |`,
    `| Total cached input tokens | ${formatTokenCount(s.totalCachedInputTokens)} |`,
    `| Avg tokens/session | ${formatTokenCount(s.avgTotalTokensPerSession)} |`,
    ``,
  ];

  // Sessions per day chart
  if (s.byDay.length > 0) {
    charts.push(sessionsPerDayChart(data));
    lines.push(`![Sessions per day](charts/sessions-per-day.png)`, ``);
  }

  // Cost chart
  if (s.byDay.length > 0 && s.totalCostUsd > 0) {
    charts.push(sessionCostChart(data));
    lines.push(`![Cost per day](charts/sessions-cost.png)`, ``);
  }

  // Daily breakdown table
  if (s.byDay.length > 0) {
    lines.push(
      `## Daily Breakdown`,
      ``,
      `| Date | Sessions | OK | Fail | Cost | Avg Turns | Tokens |`,
      `|------|----------|----|------|------|-----------|--------|`,
    );
    for (const d of s.byDay) {
      const totalTokens = d.totalInputTokens + d.totalOutputTokens;
      lines.push(
        `| ${d.date} | ${d.sessions} | ${d.successes} | ${d.failures} | $${d.totalCostUsd.toFixed(2)} | ${d.avgTurns} | ${formatTokenCount(totalTokens)} |`,
      );
    }
    lines.push(``);
  }

  // Budget status
  if (data.budgets.length > 0) {
    lines.push(`## Budget Status`, ``);
    for (const b of data.budgets) {
      lines.push(`### ${b.project}`, ``);
      charts.push(budgetGaugeChart(b));
      lines.push(`![Budget: ${b.project}](charts/budget-${b.project}.png)`, ``);

      lines.push(`| Resource | Consumed | Limit | Usage |`);
      lines.push(`|----------|----------|-------|-------|`);
      for (const r of b.resources) {
        const bar = progressBar(r.pct);
        lines.push(`| ${r.resource} | ${r.consumed} | ${r.limit} ${r.unit} | ${bar} ${r.pct}% |`);
      }
      if (b.deadline) {
        const timeStr = b.hoursToDeadline != null
          ? b.hoursToDeadline <= 0 ? "PASSED" : `${b.hoursToDeadline}h remaining`
          : "";
        lines.push(``, `Deadline: ${b.deadline} (${timeStr})`);
      }
      if (b.projectedExhaustion) {
        lines.push(`Projected exhaustion: ${b.projectedExhaustion}`);
      }
      lines.push(``);
    }
  }

  // Efficiency section
  const e = data.efficiency;
  if (e.totalSessions > 0) {
    lines.push(
      `## Efficiency`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Findings/dollar | ${e.findingsPerDollar.toFixed(2)} |`,
      `| Avg cost/finding | $${e.avgCostPerFinding.toFixed(2)} |`,
      `| Avg turns/finding | ${e.avgTurnsPerFinding.toFixed(1)} |`,
      `| Zero-knowledge rate | ${(e.zeroKnowledgeRate * 100).toFixed(1)}% |`,
      `| Genuine waste rate | ${(e.genuineWasteRate * 100).toFixed(1)}% |`,
      ``,
    );

    // Findings-per-dollar chart
    if (e.byDay.length > 0) {
      charts.push(findingsPerDollarChart(e));
      lines.push(`![Findings per dollar](charts/findings-per-dollar.png)`, ``);
    }

    // Zero-knowledge rate chart
    if (e.byDay.length > 0) {
      charts.push(zeroKnowledgeRateChart(e));
      lines.push(`![Zero-knowledge rate](charts/zero-knowledge-rate.png)`, ``);
    }

    // Daily efficiency breakdown
    if (e.byDay.length > 0) {
      lines.push(
        `### Daily Efficiency`,
        ``,
        `| Date | Sessions | Findings | Cost | Findings/$ | Zero-K |`,
        `|------|----------|----------|------|------------|--------|`,
      );
      for (const d of e.byDay) {
        lines.push(
          `| ${d.date} | ${d.sessions} | ${d.totalFindings} | $${d.totalCostUsd.toFixed(2)} | ${d.findingsPerDollar.toFixed(2)} | ${d.zeroKnowledgeSessions} |`,
        );
      }
      lines.push(``);
    }
  }

  return { content: lines.join("\n"), charts };
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "[" + "#".repeat(filled) + "-".repeat(10 - filled) + "]";
}
