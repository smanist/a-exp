/** Project data reader — parse project READMEs for status, tasks, log entries. */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectSummary, ProjectTask, LogEntry } from "./types.js";
import { readProjectBudget } from "./data-budget.js";
import { scanExperiments } from "./data-experiments.js";

/** Parse a project README.md into a ProjectSummary. */
export function parseProjectReadme(content: string, name: string): Omit<ProjectSummary, "budget" | "experiments"> {
  const field = (label: string): string => {
    const m = content.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim() ?? "";
  };

  const status = field("Status");
  const mission = field("Mission");
  const doneWhen = field("Done when");

  // Parse log entries (### YYYY-MM-DD headings)
  const logEntries: LogEntry[] = [];
  const logMatch = content.match(/## Log\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (logMatch) {
    const logSection = logMatch[1];
    const entryBlocks = logSection.split(/(?=^### \d{4}-\d{2}-\d{2})/m).filter((b) => b.trim().startsWith("### "));
    for (const block of entryBlocks.slice(0, 10)) {
      const dateMatch = block.match(/^### (\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        logEntries.push({
          date: dateMatch[1],
          content: block.trim(),
        });
      }
    }
  }

  // Parse tasks from ## Next actions
  const tasks: ProjectTask[] = [];
  const actionsMatch = content.match(/## Next actions\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (actionsMatch) {
    for (const line of actionsMatch[1].split("\n")) {
      const taskMatch = line.match(/^- \[([ x])\]\s+(.+)/);
      if (taskMatch) {
        const done = taskMatch[1] === "x";
        const text = taskMatch[2].trim();
        const tagMatches = text.match(/\[[\w-]+(?::\s*[^\]]+)?\]/g) ?? [];
        tasks.push({ text, done, tags: tagMatches });
      }
    }
  }

  // Parse open questions
  const openQuestions: string[] = [];
  const oqMatch = content.match(/## Open questions\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (oqMatch) {
    for (const line of oqMatch[1].split("\n")) {
      const m = line.match(/^[-*]\s+(.+)/);
      if (m) openQuestions.push(m[1].trim());
    }
  }

  return { name, status, mission, doneWhen, logEntries, tasks, openQuestions };
}

/** Read all project READMEs and enrich with budget and experiment data. */
export async function readProjects(repoDir: string): Promise<ProjectSummary[]> {
  const projectsDir = join(repoDir, "projects");
  const projects: ProjectSummary[] = [];

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return [];
  }

  const allExperiments = await scanExperiments(repoDir);

  for (const entry of entries) {
    const projectPath = join(projectsDir, entry);
    try {
      const s = await stat(projectPath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const readmePath = join(projectPath, "README.md");
    try {
      const content = await readFile(readmePath, "utf-8");
      const parsed = parseProjectReadme(content, entry);
      const budget = await readProjectBudget(projectPath, entry);
      const experiments = allExperiments.filter((e) => e.project === entry);

      projects.push({ ...parsed, budget: budget ?? undefined, experiments });
    } catch {
      // No README — skip
    }
  }

  return projects;
}
