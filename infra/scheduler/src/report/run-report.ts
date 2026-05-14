#!/usr/bin/env tsx
/** CLI entry point for report generation. Invoked by the /report skill. */

import { generateAndSaveReport } from "./engine.js";
import { resolveWorkspace } from "../workspace.js";
import type { ReportType } from "./types.js";

const VALID_TYPES = new Set(["operational", "research", "project", "experiment-comparison"]);

function parseArgs(): {
  type: ReportType;
  project?: string;
  from?: string;
  to?: string;
  ids?: string[];
  repo?: string;
} {
  const args = process.argv.slice(2);
  let type: ReportType = "operational";
  let project: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let ids: string[] | undefined;
  let repo: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && args[i + 1]) {
      const t = args[++i];
      if (VALID_TYPES.has(t)) type = t as ReportType;
      else {
        console.error(`Invalid report type: ${t}. Valid: ${[...VALID_TYPES].join(", ")}`);
        process.exit(1);
      }
    } else if (args[i] === "--project" && args[i + 1]) {
      project = args[++i];
    } else if (args[i] === "--from" && args[i + 1]) {
      from = args[++i];
    } else if (args[i] === "--to" && args[i + 1]) {
      to = args[++i];
    } else if (args[i] === "--ids" && args[i + 1]) {
      ids = args[++i].split(",").map((s) => s.trim());
    } else if (args[i] === "--repo" && args[i + 1]) {
      repo = args[++i];
    }
  }

  return { type, project, from, to, ids, repo };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const workspace = resolveWorkspace({ repo: opts.repo });
  if (!workspace) {
    console.error("No a-exp workspace found. Run `a-exp init` first, or pass --repo <dir>.");
    process.exit(1);
  }
  const repoDir = workspace.root;

  console.log(`Generating ${opts.type} report...`);
  if (opts.project) console.log(`  Project filter: ${opts.project}`);
  if (opts.from) console.log(`  From: ${opts.from}`);
  if (opts.to) console.log(`  To: ${opts.to}`);
  if (opts.ids) console.log(`  Experiment IDs: ${opts.ids.join(", ")}`);

  const filepath = await generateAndSaveReport({
    type: opts.type,
    format: "markdown",
    repoDir,
    metricsPath: workspace.metricsPath,
    periodFrom: opts.from,
    periodTo: opts.to,
    project: opts.project,
    experimentIds: opts.ids,
  });

  console.log(`\nReport saved to: ${filepath}`);
  console.log(`Charts saved to: ${repoDir}/reports/charts/`);
}

main().catch((err) => {
  console.error(`Report generation failed: ${err}`);
  process.exit(1);
});
