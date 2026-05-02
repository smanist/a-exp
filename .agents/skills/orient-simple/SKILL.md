---
name: orient-simple
description: Use at the start of a work session to select a task. Simplified for models with lower reasoning capacity.
complexity: medium
model-minimum: fast
---

# orient-simple

Simplified orient skill for Fast Model and similar models. Select a task to work on in <3 turns.

## When to use

At the start of every autonomous work session, before selecting a task.

## Procedure

Execute these steps in order:

### Step 1: Check for orphaned work

Run `git status`. If there are uncommitted changes that are project work (not scheduler state files), commit them with a descriptive message. Skip scheduler state files (`.scheduler/`, `*.json` in infra).

### Step 2: Read TASKS.md files

Read all `projects/*/TASKS.md` files. For each task, note:
- `[ ]` = open, `[x]` = done
- `[in-progress: DATE]` = someone is working on it, skip
- `[blocked-by: ...]` = cannot proceed, skip
- `[approval-needed]` = requires human approval, skip
- `[zero-resource]` = costs no budget resources

### Step 3: Routing tag check

While reading TASKS.md files (Step 2), verify that `[requires-frontier]` tags are applied correctly:

**Tag `[requires-frontier]` if ANY true:**
1. NOT self-contained (needs multi-file context beyond task text + project README)
2. Unclear done-when condition (requires judgment to verify)
3. Multiple unrelated concerns ("do X, then Y, then Z" across separate outcomes)
4. Deep reasoning required (synthesis, strategic decisions, multi-step planning)
5. Convention changes (modifies AGENTS.md, decisions/, or infra/)

If your repo uses routing tags, untagged tasks may default to fleet-eligible. Only apply `[requires-frontier]` when a task genuinely needs frontier-tier capability.

### Step 4: Task supply generation and decomposition (ADR 0047, ADR 0053)

If task supply is thin, improve it before proceeding. In repos that enable fleet execution, this also helps maintain fleet-ready task supply.

**How to generate (in order):**
1. Remove stale `[blocked-by: ...]` tags where the referenced condition is resolved (prerequisite task already completed)
2. **Adjust task granularity** for `[requires-frontier]` tasks. Prefer mid-sized coherent tasks with one or more mechanical `Done when` criteria. Split only when the pieces are independently useful/verifiable, need separate approval or resource gates, or are unlikely to fit in one session. Merge over-fragmented adjacent tasks when they form one cohesive outcome. **Write task changes directly to TASKS.md** — do NOT just flag or propose, because proposals die with the session.
3. Create maintenance tasks: `Run /self-audit on <project>` for projects that haven't been audited in the last 7 days. To check: run `ls projects/*/diagnosis/compliance-audit-*.md 2>/dev/null | xargs -I{} basename {}` to list audit files. Extract dates from filenames (pattern: YYYY-MM-DD). Skip projects with audits within 7 days of today.
4. Create documentation or analysis tasks from standing inventory (see AGENTS.md "Fleet supply maintenance")

Granularity cleanup is also valuable even when task supply looks healthy.

After generating, report what changed.

### Step 5: Check project priorities

Read the first 5 lines of each `projects/*/README.md`. Look for `Priority:` field:
- `high` = highest priority
- `medium` or no field = default priority
- `low` = lowest priority

### Step 6: Mission gap check (ADR 0049)

For each high-priority project with ≤2 unblocked tasks:

1. Read the project's `Done when:` from README.md (already loaded from Step 6)
2. Check if each `Done when` condition has a corresponding open task in TASKS.md
3. If a condition has no task AND is not already satisfied, create one:
   ```
   - [ ] <verb phrase for the gap> [optional routing tag]
      Why: Mission gap — no task for "<condition>" (per ADR 0049)
      Done when: <condition from project Done when>
   ```

This prevents projects from stalling when tasks run out while the mission is incomplete.

### Step 7: Rank unblocked tasks

For each unblocked open task, score by these criteria (in order):

1. **Project priority**: high=3, medium=2, low=1
2. **Task value**: prevents waste=3, unblocks others=2, produces knowledge=1
3. **Concrete done-when**: has clear completion condition=1, vague=0

Multiply: project_priority × task_value + concrete_done_when

Example: high priority project + prevents waste + concrete done-when = 3×3+1 = 10

### Step 8: Select the highest-scored task

The task with the highest score is your task.

### Step 9: Mark task in-progress

Edit the TASKS.md file. Find your task. Add `[in-progress: YYYY-MM-DD]` after the task description.

### Step 10: Report selection

Output a single line in this format:

```
Selected: <task description> (project: <name>, priority: <level>, score: <N>)
```

If you tagged any untagged tasks during Step 3 or adjusted task granularity during Step 4, add a line:

```
Task supply updates: N tasks tagged or re-tagged. D task granularity changes.
```

## Common patterns

**Task with [blocked-by: external: ...]:** Skip. This is waiting on external work with uncertain timeline.

**All tasks blocked:** Check if there are `[zero-resource]` tasks that might be unblocked. If all tasks are genuinely blocked, end the session with a log entry noting the blockage.

**Budget check:** If a project has `budget.yaml` and the task is NOT `[zero-resource]`, compute remaining budget before claiming. If budget exhausted, select a different task or end session.

## What NOT to do

- Do NOT run the full orient skill — it's too complex for this model
- Do NOT read optional files (roadmap.md, status.md, sessions.jsonl patterns)
- Do NOT attempt cross-project strategic analysis
- Do NOT scan for compound opportunities
