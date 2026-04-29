/** Chart spec factories — generate ChartSpec configs for each report type. */

import type { ChartSpec, ReportData, BudgetSummary, EfficiencySummary } from "./types.js";

const COLORS = {
  green: "#4ade80",
  red: "#f87171",
  blue: "#60a5fa",
  yellow: "#facc15",
  purple: "#c084fc",
  cyan: "#22d3ee",
  gray: "#9ca3af",
  orange: "#fb923c",
};

// ── Operational charts ──────────────────────────────────────────────────────

export function sessionCostChart(data: ReportData): ChartSpec {
  const days = data.sessions.byDay;
  return {
    id: "sessions-cost",
    title: "Cost per Day ($)",
    config: {
      type: "bar",
      data: {
        labels: days.map((d) => d.date.slice(5)),
        datasets: [{
          label: "Cost ($)",
          data: days.map((d) => Math.round(d.totalCostUsd * 100) / 100),
          backgroundColor: COLORS.blue,
        }],
      },
      options: {
        animation: false,
        scales: {
          y: { beginAtZero: true, ticks: { color: "#b0b0b0" } },
          x: { ticks: { color: "#b0b0b0" } },
        },
      },
    },
  };
}

export function sessionsPerDayChart(data: ReportData): ChartSpec {
  const days = data.sessions.byDay;
  return {
    id: "sessions-per-day",
    title: "Sessions per Day",
    config: {
      type: "bar",
      data: {
        labels: days.map((d) => d.date.slice(5)),
        datasets: [
          { label: "Success", data: days.map((d) => d.successes), backgroundColor: COLORS.green },
          { label: "Failure", data: days.map((d) => d.failures), backgroundColor: COLORS.red },
        ],
      },
      options: {
        animation: false,
        scales: {
          x: { stacked: true, ticks: { color: "#b0b0b0" } },
          y: { stacked: true, beginAtZero: true, ticks: { color: "#b0b0b0" } },
        },
      },
    },
  };
}

export function budgetGaugeChart(budget: BudgetSummary): ChartSpec {
  const labels = budget.resources.map((r) => r.resource);
  const consumed = budget.resources.map((r) => r.pct);
  const remaining = budget.resources.map((r) => Math.max(0, 100 - r.pct));

  return {
    id: `budget-${budget.project}`,
    title: `Budget: ${budget.project}`,
    config: {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Consumed %", data: consumed, backgroundColor: COLORS.orange },
          { label: "Remaining %", data: remaining, backgroundColor: COLORS.gray },
        ],
      },
      options: {
        indexAxis: "y" as const,
        animation: false,
        scales: {
          x: { stacked: true, max: 100, ticks: { color: "#b0b0b0" } },
          y: { stacked: true, ticks: { color: "#b0b0b0" } },
        },
      },
    },
    width: 500,
    height: 250,
  };
}

// ── Research charts ─────────────────────────────────────────────────────────

export function experimentStatusChart(data: ReportData): ChartSpec {
  const statusCounts: Record<string, number> = {};
  for (const e of data.experiments) {
    statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1;
  }
  const statusColors: Record<string, string> = {
    completed: COLORS.green,
    running: COLORS.blue,
    planned: COLORS.yellow,
    failed: COLORS.red,
    abandoned: COLORS.gray,
  };

  return {
    id: "experiment-status",
    title: "Experiments by Status",
    config: {
      type: "doughnut",
      data: {
        labels: Object.keys(statusCounts),
        datasets: [{
          data: Object.values(statusCounts),
          backgroundColor: Object.keys(statusCounts).map((s) => statusColors[s] ?? COLORS.purple),
        }],
      },
      options: { animation: false },
    },
    width: 400,
    height: 400,
  };
}

export function knowledgeOutputChart(data: ReportData): ChartSpec {
  // Group experiments by project and count findings
  const projectFindings: Record<string, number> = {};
  for (const e of data.experiments) {
    projectFindings[e.project] = (projectFindings[e.project] ?? 0) + e.findingsCount;
  }

  return {
    id: "knowledge-output",
    title: "Findings by Project",
    config: {
      type: "bar",
      data: {
        labels: Object.keys(projectFindings),
        datasets: [{
          label: "Findings",
          data: Object.values(projectFindings),
          backgroundColor: COLORS.purple,
        }],
      },
      options: {
        animation: false,
        scales: {
          y: { beginAtZero: true, ticks: { color: "#b0b0b0" } },
          x: { ticks: { color: "#b0b0b0" } },
        },
      },
    },
  };
}

// ── Efficiency charts ──────────────────────────────────────────────────────

export function findingsPerDollarChart(efficiency: EfficiencySummary): ChartSpec {
  const days = efficiency.byDay;
  return {
    id: "findings-per-dollar",
    title: "Findings per Dollar (by day)",
    config: {
      type: "bar",
      data: {
        labels: days.map((d) => d.date.slice(5)),
        datasets: [{
          label: "Findings/$",
          data: days.map((d) => Math.round(d.findingsPerDollar * 100) / 100),
          backgroundColor: COLORS.green,
        }],
      },
      options: {
        animation: false,
        scales: {
          y: { beginAtZero: true, ticks: { color: "#b0b0b0" } },
          x: { ticks: { color: "#b0b0b0" } },
        },
      },
    },
  };
}

export function zeroKnowledgeRateChart(efficiency: EfficiencySummary): ChartSpec {
  const days = efficiency.byDay;
  return {
    id: "zero-knowledge-rate",
    title: "Zero-Knowledge Sessions (by day)",
    config: {
      type: "bar",
      data: {
        labels: days.map((d) => d.date.slice(5)),
        datasets: [
          {
            label: "Zero-knowledge",
            data: days.map((d) => d.zeroKnowledgeSessions),
            backgroundColor: COLORS.red,
          },
          {
            label: "Productive",
            data: days.map((d) => d.sessions - d.zeroKnowledgeSessions),
            backgroundColor: COLORS.green,
          },
        ],
      },
      options: {
        animation: false,
        scales: {
          x: { stacked: true, ticks: { color: "#b0b0b0" } },
          y: { stacked: true, beginAtZero: true, ticks: { color: "#b0b0b0" } },
        },
      },
    },
  };
}

// ── Experiment comparison charts ────────────────────────────────────────────

export function experimentComparisonChart(
  experiments: ReportData["experiments"],
): ChartSpec | null {
  const completed = experiments.filter((e) => e.status === "completed" && e.findingsCount > 0);
  if (completed.length === 0) return null;

  return {
    id: "experiment-comparison",
    title: "Findings per Experiment",
    config: {
      type: "bar",
      data: {
        labels: completed.map((e) => e.id.slice(0, 20)),
        datasets: [{
          label: "Findings",
          data: completed.map((e) => e.findingsCount),
          backgroundColor: COLORS.cyan,
        }],
      },
      options: {
        animation: false,
        indexAxis: "y" as const,
        scales: {
          x: { beginAtZero: true, ticks: { color: "#b0b0b0" } },
          y: { ticks: { color: "#b0b0b0", font: { size: 10 } } },
        },
      },
    },
    width: 600,
    height: Math.max(300, completed.length * 30),
  };
}
