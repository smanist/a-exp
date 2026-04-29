/** Report engine — dispatches to the correct renderer based on type and format. */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gatherReportData } from "./aggregator.js";
import { renderChart } from "./chart-render.js";
import { renderOperationalMarkdown } from "./render-operational.js";
import { renderResearchDigestMarkdown } from "./render-research-digest.js";
import { renderProjectStatusMarkdown } from "./render-project-status.js";
import { renderExperimentComparisonMarkdown } from "./render-experiment-comparison.js";
import type { ReportOptions, ReportResult, ChartSpec } from "./types.js";

/** Generate a report and return the content + rendered chart buffers. */
export async function generateReport(opts: ReportOptions): Promise<ReportResult> {
  const data = await gatherReportData(opts.repoDir, opts.periodFrom, opts.periodTo, opts.metricsPath);

  let content: string;
  let chartSpecs: ChartSpec[];

  switch (opts.type) {
    case "operational": {
      const result = renderOperationalMarkdown(data);
      content = result.content;
      chartSpecs = result.charts;
      break;
    }
    case "research": {
      const result = renderResearchDigestMarkdown(data);
      content = result.content;
      chartSpecs = result.charts;
      break;
    }
    case "project": {
      const result = renderProjectStatusMarkdown(data, opts.project);
      content = result.content;
      chartSpecs = result.charts;
      break;
    }
    case "experiment-comparison": {
      const result = renderExperimentComparisonMarkdown(data, opts.experimentIds);
      content = result.content;
      chartSpecs = result.charts;
      break;
    }
  }

  // Render all charts to PNG
  const charts: { id: string; buffer: Buffer }[] = [];
  for (const spec of chartSpecs) {
    try {
      const buffer = await renderChart(spec);
      charts.push({ id: spec.id, buffer });
    } catch (err) {
      console.error(`[report] Failed to render chart ${spec.id}: ${err}`);
    }
  }

  return { content, charts };
}

/** Generate a report and save it to the reports/ directory. */
export async function generateAndSaveReport(opts: ReportOptions): Promise<string> {
  const result = await generateReport(opts);

  const reportsDir = join(opts.repoDir, "reports");
  const chartsDir = join(reportsDir, "charts");
  await mkdir(chartsDir, { recursive: true });

  // Save charts
  for (const chart of result.charts) {
    await writeFile(join(chartsDir, `${chart.id}.png`), chart.buffer);
  }

  // Save markdown
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${opts.type}-${date}.md`;
  const filepath = join(reportsDir, filename);
  await writeFile(filepath, result.content, "utf-8");

  return filepath;
}
