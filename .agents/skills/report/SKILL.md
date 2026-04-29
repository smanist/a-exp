---
name: report
description: "Use when a status report, research digest, or experiment comparison is needed for human review"
complexity: medium
model-minimum: standard
allowed-tools: ["Read", "Grep", "Glob", "Write", "Bash(cd infra/scheduler && npx tsx src/report/run-report.ts *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git status)", "Bash(git add *)", "Bash(git commit *)"]
argument-hint: "<type> [project=<name>] [from=YYYY-MM-DD] [to=YYYY-MM-DD]"
---

# /report <type> [options]

Generate a formatted report with charts from akari's data sources.

## Report types

| Type | Argument | What it shows |
|------|----------|---------------|
| Operational | `operational` | Session health, cost trend, budget burn rates, verification compliance |
| Research digest | `research` | Experiments completed, findings, decision records, knowledge output |
| Project status | `project [project=<name>]` | Per-project health, tasks, budget, experiments, log entries |
| Experiment comparison | `experiment-comparison [ids=<id1,id2>]` | Side-by-side experiment results and parameter diffs |

## Procedure

### Step 1: Parse arguments

Extract from the user's message:
- **type**: one of `operational`, `research`, `project`, `experiment-comparison` (default: `operational`)
- **project**: optional project name filter (for `project` and `experiment-comparison` types)
- **from**: optional start date (ISO format, default: 7 days ago)
- **to**: optional end date (ISO format, default: today)
- **ids**: optional comma-separated experiment IDs (for `experiment-comparison`)

### Step 2: Generate report

Run the report generator:

```bash
cd infra/scheduler && npx tsx src/report/run-report.ts --type <type> [--project <name>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--ids id1,id2]
```

This generates:
- A markdown report at `reports/<type>-<date>.md`
- Chart images at `reports/charts/*.png`

### Step 3: Display results

1. Read the generated markdown report file.
2. Present the key findings to the user, including:
   - Summary statistics
   - Notable trends or warnings
   - Budget alerts (if any resources >80% consumed)
3. Mention the chart files generated in `reports/charts/`.

### Step 4: Commit (if requested)

If the user wants to preserve the report:
1. `git add reports/`
2. `git commit -m "report: <type> <date>"`

## Examples

- `/report operational` — generates operational dashboard for the last 7 days
- `/report research from=2026-02-10` — research digest since Feb 10
- `/report project project=sample-project` — sample-project status
- `/report experiment-comparison ids=strategic-100,model-comparison-focused-v2` — compare two experiments
