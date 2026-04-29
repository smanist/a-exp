/** Slack Block Kit renderers for all 4 report types.
 *  Text-based visualizations as fallback (no dashboard dependency). */

import type { ReportData, BudgetSummary } from "./types.js";

type Block = Record<string, unknown>;

// ── Shared helpers ──────────────────────────────────────────────────────────

function header(text: string): Block {
  return { type: "header", text: { type: "plain_text", text } };
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function fields(...pairs: string[]): Block {
  return {
    type: "section",
    fields: pairs.map((t) => ({ type: "mrkdwn", text: t })),
  };
}

function divider(): Block {
  return { type: "divider" };
}

/** Text-based progress bar using block characters. */
function textBar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function budgetLine(r: { resource: string; consumed: number; limit: number; unit: string; pct: number }): string {
  const icon = r.pct >= 100 ? ":no_entry:" : r.pct >= 80 ? ":warning:" : ":large_green_circle:";
  return `${icon} *${r.resource}*: ${r.consumed}/${r.limit} ${r.unit} \`${textBar(r.pct)}\` ${r.pct}%`;
}

function budgetBlocks(budgets: BudgetSummary[]): Block[] {
  if (budgets.length === 0) return [];
  const blocks: Block[] = [divider()];

  for (const b of budgets) {
    const lines = b.resources.map(budgetLine);
    if (b.deadline) {
      const timeStr = b.hoursToDeadline != null
        ? b.hoursToDeadline <= 0 ? "PASSED" : `${b.hoursToDeadline}h remaining`
        : "";
      const icon = b.hoursToDeadline != null && b.hoursToDeadline <= 0 ? ":no_entry:" : ":calendar:";
      lines.push(`${icon} *Deadline*: ${b.deadline} (${timeStr})`);
    }
    blocks.push(section(`:bar_chart: *Budget — ${b.project}:*\n${lines.join("\n")}`));
  }

  return blocks;
}

function formatTokenCount(n: number): string {
  return n.toLocaleString("en-US");
}

// ── Operational report ──────────────────────────────────────────────────────

export function renderOperationalSlack(data: ReportData): Block[] {
  const s = data.sessions;
  const blocks: Block[] = [
    header(":chart_with_upwards_trend: Operational Report"),
    section(`_${data.period.from} to ${data.period.to}_`),
    fields(
      `*Sessions:*\n${s.totalSessions}`,
      `*Success rate:*\n${(s.successRate * 100).toFixed(0)}%`,
      `*Total cost:*\n$${s.totalCostUsd.toFixed(2)}`,
      `*Avg cost:*\n$${s.avgCostPerSession.toFixed(2)}`,
    ),
    fields(
      `*Avg duration:*\n${Math.round(s.avgDurationMs / 60000)} min`,
      `*Avg turns:*\n${s.avgTurns}`,
      `*Input/output tokens:*\n${formatTokenCount(s.totalInputTokens)}/${formatTokenCount(s.totalOutputTokens)}`,
      `*Avg tokens/session:*\n${formatTokenCount(s.avgTotalTokensPerSession)}`,
    ),
  ];

  // Daily breakdown (compact text table)
  if (s.byDay.length > 0) {
    const rows = s.byDay.map((d) =>
      `${d.date.slice(5)}  ${d.sessions} sess  ${d.successes}/${d.sessions} ok  $${d.totalCostUsd.toFixed(1)}  ${formatTokenCount(d.totalInputTokens + d.totalOutputTokens)} tok`,
    );
    blocks.push(divider(), section(`*Daily breakdown:*\n\`\`\`\n${rows.join("\n")}\n\`\`\``));
  }

  // Budget status
  blocks.push(...budgetBlocks(data.budgets));

  return blocks;
}

// ── Research digest ─────────────────────────────────────────────────────────

export function renderResearchSlack(data: ReportData): Block[] {
  const k = data.knowledge;
  const blocks: Block[] = [
    header(":microscope: Research Digest"),
    section(`_${data.period.from} to ${data.period.to}_`),
    fields(
      `*Experiments:*\n${k.totalExperiments} total (${k.completedExperiments} done)`,
      `*Findings:*\n${k.totalFindings}`,
      `*Decisions:*\n${k.decisionRecords}`,
      `*Findings/exp:*\n${k.avgFindingsPerExperiment}`,
    ),
  ];

  // Recent completed experiments
  const completed = data.experiments
    .filter((e) => e.status === "completed")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  if (completed.length > 0) {
    const lines = completed.map((e) =>
      `• *${e.id}* (${e.project}) — ${e.findingsCount} findings`,
    );
    blocks.push(divider(), section(`*Recently completed:*\n${lines.join("\n")}`));
  }

  // Pipeline
  const pipeline = data.experiments.filter((e) => e.status === "running" || e.status === "planned");
  if (pipeline.length > 0) {
    const lines = pipeline.slice(0, 5).map((e) => {
      const icon = e.status === "running" ? ":test_tube:" : ":clipboard:";
      return `${icon} *${e.id}* (${e.project}) — ${e.status}`;
    });
    if (pipeline.length > 5) lines.push(`_...and ${pipeline.length - 5} more_`);
    blocks.push(divider(), section(`*Experiment pipeline:*\n${lines.join("\n")}`));
  }

  return blocks;
}

// ── Project status ──────────────────────────────────────────────────────────

export function renderProjectSlack(data: ReportData, projectFilter?: string): Block[] {
  const projects = projectFilter
    ? data.projects.filter((p) => p.name === projectFilter)
    : data.projects;

  const blocks: Block[] = [
    header(":package: Project Status"),
  ];

  if (projects.length === 0) {
    blocks.push(section(`No projects found${projectFilter ? ` matching "${projectFilter}"` : ""}.`));
    return blocks;
  }

  for (const p of projects) {
    const statusIcon = p.status === "active" ? ":large_green_circle:" : p.status === "paused" ? ":yellow_circle:" : ":white_check_mark:";
    const doneTasks = p.tasks.filter((t) => t.done).length;
    const openTasks = p.tasks.filter((t) => !t.done).length;
    const expDone = p.experiments.filter((e) => e.status === "completed").length;

    blocks.push(
      divider(),
      section(`${statusIcon} *${p.name}* — _${p.status}_`),
      fields(
        `*Mission:*\n${p.mission.slice(0, 100)}${p.mission.length > 100 ? "…" : ""}`,
        `*Tasks:*\n${doneTasks}/${p.tasks.length} done (${openTasks} open)`,
      ),
    );

    if (p.experiments.length > 0) {
      blocks.push(fields(
        `*Experiments:*\n${expDone}/${p.experiments.length} completed`,
        `*Questions:*\n${p.openQuestions.length} open`,
      ));
    }

    // Budget inline
    if (p.budget) {
      const lines = p.budget.resources.map(budgetLine);
      blocks.push(section(lines.join("\n")));
    }

    // Top open tasks
    const open = p.tasks.filter((t) => !t.done).slice(0, 3);
    if (open.length > 0) {
      const taskLines = open.map((t) => `• ${t.text.slice(0, 80)}`);
      if (openTasks > 3) taskLines.push(`_...and ${openTasks - 3} more_`);
      blocks.push(section(`*Open tasks:*\n${taskLines.join("\n")}`));
    }
  }

  return blocks;
}

// ── Experiment comparison ───────────────────────────────────────────────────

export function renderExperimentComparisonSlack(
  data: ReportData,
  experimentIds?: string[],
): Block[] {
  const experiments = experimentIds
    ? data.experiments.filter((e) => experimentIds.includes(e.id))
    : data.experiments.filter((e) => e.status === "completed").slice(0, 10);

  const blocks: Block[] = [
    header(":scales: Experiment Comparison"),
  ];

  if (experiments.length === 0) {
    blocks.push(section("No experiments found for comparison."));
    return blocks;
  }

  // Comparison table as text
  const rows = experiments.map((e) =>
    `*${e.id}*  ${e.project}  ${e.status}  ${e.findingsCount} findings  ${e.date}`,
  );
  blocks.push(section(rows.join("\n")));

  // Per-experiment details
  for (const e of experiments.slice(0, 5)) {
    const tags = e.tags.length > 0 ? `\nTags: ${e.tags.join(", ")}` : "";
    blocks.push(
      divider(),
      section(`*${e.id}* (${e.project})\nType: ${e.type} | Status: ${e.status} | Findings: ${e.findingsCount}${tags}`),
    );
  }

  if (experiments.length > 5) {
    blocks.push(section(`_...and ${experiments.length - 5} more experiments_`));
  }

  return blocks;
}
