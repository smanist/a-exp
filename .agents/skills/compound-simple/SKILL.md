---
name: compound-simple
description: Use at the end of a work session to embed learnings into conventions. Simplified for models with lower reasoning capacity.
complexity: medium
model-minimum: fast
---

# compound-simple

Simplified compound skill for Fast Model and similar models. Embed session learnings in <3 turns.

## When to use

At the end of every autonomous work session, after completing work but before commit.

## Procedure

Execute these steps in order:

### Step 1: Review what changed

Run `git diff --stat HEAD~N..HEAD` where N is commits this session. Answer:
- What files changed?
- What was accomplished?

### Step 2: Check for learnings (4 questions)

Answer each question. If yes, note what to update:

1. **Non-obvious fact discovered?** (API quirk, hidden constraint, unclear convention)
   → Update relevant file (AGENTS.md, skill, or project file)

2. **Failure mode others should avoid?** (silent error, misleading config, common mistake)
   → Add warning/gotcha to relevant skill

3. **Technique that worked well?** (debugging strategy, analysis pattern)
   → If generalizes: note for future gravity evaluation

4. **Convention friction?** (rule didn't fit, schema too rigid)
   → Update convention or note friction

### Step 3: Check for implied tasks

If you completed an experiment/analysis, scan EXPERIMENT.md Findings for:
- "N too small" → task: larger replication
- "FAIL" or "below threshold" → task: refined experiment
- "unexpected", "mechanism unclear" → task: diagnosis
- Multi-phase plan → check phase tasks exist

### Step 4: Act on findings

For each compound opportunity:

| Type | Action |
|------|--------|
| Small update (1-3 lines) | Apply directly to file |
| Larger change | Create task in TASKS.md |
| Recurring pattern | Create task: "Run /gravity on: <pattern>" |
| Governance change | Write to APPROVAL_QUEUE.md |

### Step 5: Report actions

Output in this format:

```
Compound: N actions
- <action 1>
- <action 2>
...
```

If no actions: `Compound: no actions this session.`

## What NOT to do

- Do NOT run full /compound skill — too complex
- Do NOT start new work — compound embeds learnings only
- Do NOT scan cross-session patterns or convention registry
- Do NOT make governance changes without approval queue
- Do NOT add >10 lines without identifying lines to compress

## Key files to update

- `AGENTS.md` — conventions, gotchas
- `.Codex/skills/*/SKILL.md` — skill instructions
- `projects/*/README.md` — project-specific learnings
- `projects/*/TASKS.md` — implied follow-up tasks
