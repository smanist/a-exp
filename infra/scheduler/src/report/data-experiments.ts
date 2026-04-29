/** Experiment data reader — scan EXPERIMENT.md files across all projects. */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExperimentRecord } from "./types.js";

/** Parse a single EXPERIMENT.md file into an ExperimentRecord. */
export function parseExperimentMd(content: string, relativePath: string): ExperimentRecord {
  // Parse YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm: Record<string, string> = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w[\w_-]*):\s*(.+)$/);
      if (m) fm[m[1]] = m[2].trim();
    }
  }

  // Parse tags (YAML array on one line: [tag1, tag2])
  const tagsStr = fm.tags ?? "";
  const tags = tagsStr.startsWith("[")
    ? tagsStr.slice(1, -1).split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  // Extract title from first # heading
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1] ?? fm.id ?? "Untitled";

  // Count findings (numbered items under ## Findings)
  let findingsCount = 0;
  const findingsMatch = content.match(/## Findings\n([\s\S]*?)(?=\n##|$)/);
  if (findingsMatch) {
    const findingsLines = findingsMatch[1].split("\n");
    for (const line of findingsLines) {
      if (line.match(/^\d+\.\s+/)) findingsCount++;
    }
  }

  // Also count **Key findings** in log-style entries
  const keyFindingsMatch = content.match(/\*\*Key findings \((\d+)\)/);
  if (keyFindingsMatch && findingsCount === 0) {
    findingsCount = parseInt(keyFindingsMatch[1], 10);
  }

  return {
    id: fm.id ?? relativePath.split("/").pop() ?? "unknown",
    project: fm.project ?? "unknown",
    type: fm.type ?? "experiment",
    status: fm.status ?? "unknown",
    date: fm.date ?? "",
    tags,
    consumesResources: fm.consumes_resources === "true",
    findingsCount,
    title,
    path: relativePath,
  };
}

/** Scan all projects for EXPERIMENT.md files. */
export async function scanExperiments(repoDir: string): Promise<ExperimentRecord[]> {
  const experiments: ExperimentRecord[] = [];
  const projectsDir = join(repoDir, "projects");

  let projectNames: string[];
  try {
    projectNames = await readdir(projectsDir);
  } catch {
    return [];
  }

  for (const projectName of projectNames) {
    const expDir = join(projectsDir, projectName, "experiments");
    let expNames: string[];
    try {
      expNames = await readdir(expDir);
    } catch {
      continue;
    }

    for (const expName of expNames) {
      const expPath = join(expDir, expName);
      try {
        const s = await stat(expPath);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }

      const mdPath = join(expPath, "EXPERIMENT.md");
      try {
        const content = await readFile(mdPath, "utf-8");
        const relativePath = `projects/${projectName}/experiments/${expName}`;
        experiments.push(parseExperimentMd(content, relativePath));
      } catch {
        // No EXPERIMENT.md — skip
      }
    }
  }

  return experiments.sort((a, b) => b.date.localeCompare(a.date));
}
