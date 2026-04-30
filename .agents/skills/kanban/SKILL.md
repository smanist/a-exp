---
name: kanban
description: Generate highly compressed Markdown summaries for a-exp projects for later import into an Obsidian kanban plugin. Use when Codex needs to summarize project task progress, task/session cost from `.a-exp/logs`, experiment results from project experiment records, and report findings from project-local or workspace reports into one project-named Markdown file per project.
---

# Kanban

## Overview

Create one Obsidian-kanban-friendly Markdown summary per project under `projects/`. Each summary should compress task progress, logged execution cost, experiment results, and report conclusions into checklist cards.

## Workflow

1. Identify project directories under `projects/`.
2. For each project, read:
   - `projects/<project>/TASKS.md` for task totals and completion.
   - `.a-exp/logs/<project>-*.log` for duration, token usage, turns, and cost per completed work session or inferred task.
   - `projects/<project>/experiments/*/EXPERIMENT.md` for key results and findings.
   - `projects/<project>/reports/**/*.md` for project-local reports, if present.
   - `reports/**/*.md` only when project-local reports are absent or the report clearly references the project.
3. Generate `reports/kanban/<project>.md` by default, unless the user gives another output directory.
4. Keep every substantive card as a single top-level checkbox line. Avoid nested bullets because Obsidian kanban plugins often treat top-level checklist items as cards.
5. After generation, read the output and tighten wording manually if needed. The final file should be evidence-dense, not a prose report.

## Output Format

Use exactly two sections per project:

```markdown
## <project>-Tasks
- [x] **Progress**: <br>- <total> in total, <done> done
- [x] **Cost**: <br>- <task/session label>: <seconds>s, <tokens> tokens, <turns> turns, <cost>; <br>- ...

## <project>-Results
- [x] **Experiment** <experiment-id>: <br>- <key result>; <br>- <key finding>; <br>- <artifact/result pointer if useful>
- [x] **Report** <report-id>: <br>- <key finding>; <br>- <conclusion>
```

Use `[x]` for generated summary cards. Use `[ ]` only when the card represents a missing source, unresolved question, or incomplete project item that should remain visibly open in Obsidian.

## Compression Rules

- Prefer numbers over adjectives: `mean RMSE 0.483517` is better than `performed best`.
- Preserve identifiers: task titles, experiment IDs, report filenames, artifact paths, dates, and metric names.
- Summarize each experiment or report in one checklist item. Bold the card type (`**Progress**`, `**Cost**`, `**Experiment**`, `**Report**`) and separate compressed bullet fragments with literal `<br>- ` tags inside the card.
- If a source has a `## Findings` section, prefer those bullets over earlier design or protocol sections.
- If a report has a `## Conclusion` section, include the conclusion unless it duplicates the findings.
- Do not invent cost attribution. If a log cannot be matched to a task, label it as a session using the log timestamp.
- Keep paths relative to the repo root.

## Helper Script

Use `scripts/generate_kanban.py` for the first pass:

```bash
python .agents/skills/kanban/scripts/generate_kanban.py --repo-root . --output-dir reports/kanban
```

The script counts tasks, parses `.a-exp/logs`, extracts finding bullets from experiments and reports, and writes one `<project>.md` file per project. It is intentionally conservative; after running it, inspect the generated Markdown and compress or correct any card whose attribution is ambiguous.

Useful options:

- `--dry-run`: print summaries instead of writing files.
- `--max-cost-items N`: limit how many log/session cost entries appear in the cost card.
- `--max-result-bullets N`: limit finding bullets per experiment or report card.
