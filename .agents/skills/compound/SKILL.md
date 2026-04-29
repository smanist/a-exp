---
name: compound
description: "Use at the end of a work session, or when accumulated findings need to be embedded into conventions, skills, or patterns"
complexity: medium
model-minimum: standard
disable-model-invocation: false
allowed-tools: ["Read", "Grep", "Glob", "Bash(git diff *)", "Bash(git log *)"]
argument-hint: "[optional: 'fast', 'deep', or no argument for auto-detect]"
---

# /compound [mode]

Compound engineering phase — turns session work into accumulated system advantage by embedding learnings into conventions, skills, and patterns. Invoked as Step 5 of autonomous work cycle SOP.

## Tier selection

- `/compound fast` — 1-2 turns, skip cross-session scanning
- `/compound deep` — 10-15 min, full procedure with deep-mode scope
- `/compound` (no argument) — auto-detect: scheduler injects directive to use fast if full ran <3h ago; otherwise run full

**Rationale:** 83% of sessions produce zero compound actions. Fast saves ~$5.40/day by skipping redundant cross-session scans. See `projects/a-exp/analysis/compound-step-overhead-analysis.md`.

## Fast compound

### Step 1: Review session work
Run `!git diff --stat HEAD~N..HEAD`. Identify what changed.

### Step 2: Check for session learnings
Ask the 4 questions from Step 2: non-obvious facts, failure modes, useful techniques, convention friction.

### Step 3: Quick task discovery
If completed experiment/analysis, check EXPERIMENT.md Findings for: unresolved questions, failed criteria, "N too small", multi-phase gaps. Create task with provenance if found.

### Step 4: Fleet output spot-check
Read last 5 fleet sessions from `.scheduler/metrics/sessions.jsonl` (entries with `"triggerSource":"fleet"`). Check: verification pass rate, any 0-commit or 0-turn sessions. Report: "Fleet: N/M passed" or "Fleet: no recent sessions."

### Step 5: Act on learnings
Apply small updates directly. Larger changes → task. See Step 10 for growth accounting and 400-line gate.

### Output (fast)
`Compound (fast): N actions — <summary>.` or `Compound (fast): no actions.`

Skip cross-session scanning — covered by full compound.

---

**Pre-compound commit:** Check `git status`. Commit uncommitted session work first.

## Full compound

The standard compound procedure. Runs when auto-detection determines a full scan is needed (~2-5 minutes), or when explicitly requested without the `fast` argument.

## Background

Compound engineering turns individual session work into accumulated system advantage. The compound phase embeds learnings from each task into conventions, skills, and patterns — transforming linear progress into exponential improvement. See `projects/a-exp/analysis/ralph-loop-architecture-analysis.md` for the underlying pattern.

## Principles

1. **Small, correct updates over ambitious rewrites.** Fix a typo in a convention, add a one-line gotcha to a skill, note a pattern for future gravity evaluation. Don't redesign AGENTS.md in a compound step.
2. **Evidence over intuition.** Only embed learnings that are grounded in concrete session experience. "I noticed X went wrong" → update. "I think Y might be better" → task for evaluation, not direct change.
3. **Classify before acting.** Every potential compound action falls into one of the output categories below. Classify first, then act.
4. **Respect approval gates.** AGENTS.md edits that change governance (approval workflow, budget rules) are STRUCTURAL (non-verifiable) per the SOP. Write to APPROVAL_QUEUE.md instead of applying directly. Convention clarifications, gotcha additions, and skill improvements are STRUCTURAL (verifiable) — apply directly.

## Full procedure

### Step 1: Review session work

Run `!git diff --stat HEAD~N..HEAD` (where N is the number of commits in this session) to see what changed. If this is an end-of-session invocation, the diff is against the pre-session HEAD.

Identify:
- What task was completed (or partially completed)?
- What files were created or modified?
- Were there any surprises, workarounds, or difficulties during execution?

### Step 2: Check for session learnings

Ask these questions about the session's work:

1. **Did I discover a non-obvious fact?** (e.g., an API behaves differently than documented, a file format has an undocumented constraint, a convention is ambiguous in edge cases)
   → If yes: should this fact live in AGENTS.md, a skill, or a project file?

2. **Did I encounter a failure mode that future sessions should avoid?** (e.g., a command that silently fails, a configuration that looks correct but isn't, a common mistake in a workflow)
   → If yes: add a gotcha/warning to the relevant skill or convention.

3. **Did I develop a technique or approach that worked well?** (e.g., a debugging strategy, an analysis pattern, a verification method)
   → If yes and it generalizes beyond this one task: note it as a gravity candidate or add to a skill.

4. **Did I work around a convention that didn't fit?** (e.g., a AGENTS.md rule that was unhelpful, a schema that was too rigid, a skill instruction that was misleading)
   → If yes: update the convention/skill to handle the edge case, or note the friction for future evaluation.

### Step 3: Scan for unactioned recommendations and implied tasks (full: last 7 days, deep: last 14 days)

This step has two parts: (A) explicit recommendation sections, and (B) implied tasks from findings.

#### Part A: Explicit recommendation sections

Search recent files for "Recommendations", "Prevention", "Proposal", "Migration", or "Next steps" sections:

```
projects/*/diagnosis/diagnosis-*.md, projects/*/postmortem/postmortem-*.md
projects/*/experiments/*/EXPERIMENT.md (status: completed in last N days)
projects/a-exp/feedback/*.md, projects/a-exp/analysis/*.md, projects/a-exp/architecture/*.md
decisions/*.md (with Migration or Consequences action items)
```

For each file: check if recommendations are relevant to this session's area, trivially actionable, or (for ADRs) whether migration steps are implemented.

**Automated extraction** — use logic from `infra/scheduler/src/recommendations.ts`:
1. Extract sections via `RECOMMENDATION_HEADER_RE` pattern
2. Parse numbered/bulleted items as separate recommendations
3. Skip non-actionable items ("Do not", purely observational, no action verb)
4. Format as tasks: `- [ ] <imperative> [zero-resource] Why: From <exp-id> — <summary> Done when: <condition>`
5. Deduplicate against existing TASKS.md entries (experiment-id in Why field, or >50% keyword overlap)
6. Present candidates for agent review — do not auto-append
7. Mark processed: `<!-- Recommendations surfaced: YYYY-MM-DD -->`

**Anti-loop check**: For recommendations about analyzing running experiments, split into preliminary + final analysis tasks per [decisions/0023-incremental-analysis-throttling.md](../../../decisions/0023-incremental-analysis-throttling.md).

**Fleet routing (ADR 0045)**: When creating new tasks (from recommendations, implied tasks, or any other source), untagged tasks default to fleet-eligible. Only apply `[requires-frontier]` when a task fails the fleet-eligibility checklist from AGENTS.md. When a recommended action can be decomposed into subtasks, prefer creating multiple fleet-eligible subtasks over a single complex task.

#### Part B: Implied tasks from experiment findings

**Note:** `verify.ts` now runs an L0 check (ADR 0060) that detects actionable language in Findings/Implications without a corresponding TASKS.md modification. This compound step provides the deeper semantic scan for cases the regex misses.

Completed experiments often have implied follow-up work in Findings sections that lacks a formal "Recommendations" header. Scan for:

| Pattern | Signal phrases | Implied task |
|---------|----------------|--------------|
| Failed criterion | "FAIL", "below threshold" | Refined experiment |
| Insufficient sample | "N too small", "cannot draw conclusions" | Larger replication |
| Confound | "confound", "cannot separate" | Controlled follow-up |
| Partial confirmation | "partially confirmed", "effect exists but" | Targeted investigation |
| Unexplained result | "unexpected", "mechanism unclear" | Diagnosis |
| Multi-phase plan | "Phase N" in body | Check phase-tasks exist |

For each pattern: check TASKS.md for existing follow-up; create task candidate with experiment provenance if missing. Multi-phase: grep for "Phase [0-9]" and verify corresponding tasks exist.

### Step 4: Surface research questions

Extract implicit research questions from three sources. In full mode: current session/project only. In deep mode: all active projects.

#### Source 1: Experiment findings with unexplained results

Scan EXPERIMENT.md Findings sections for implicit questions:

| Pattern | Signal phrases | Question form |
|---------|----------------|---------------|
| Unexplained result | "unexpected", "mechanism unclear" | "Why does X despite Y?" |
| Untestable hypothesis | "cannot be tested", "future work" | "Under what conditions does H hold?" |
| Aggregate-stratum reversal | "aggregate masks", "breakdown reveals opposite" | "What drives reversal between aggregate and per-X?" |
| Methodology confound | "protocol asymmetry", "cannot separate" | "How to disentangle X from Y?" |

For each pattern: state question clearly, reference source experiment/finding, identify CI layers, note what data/methodology would resolve it.

#### Source 2: Cross-session patterns with unknown root causes

Read `detectPatterns()` output from `infra/scheduler/src/patterns.ts` (or run on `.scheduler/metrics/sessions.jsonl`). For each high/medium severity pattern without documented root cause: "Why does [pattern] recur despite [existing mitigation]?"

#### Source 3: Literature gaps

Check `projects/*/literature/synthesis.md` and recent `/lit-review` outputs for gap analysis sections. Formulate questions for gaps not already in "Open questions".

#### Deduplication

Before proposing: read target project's "Open questions", check for semantic overlap, skip questions already covered. Present candidates:

```
Candidate research question for <project>:
  Q: <question>
  Source: <exp-id, Finding N> or <pattern-id> or <literature gap>
  CI layers: <layers>
  To resolve: <data/methodology needed>
  Status: NEW | OVERLAPS WITH "<existing question>"
```

Agent decides whether to append. Do not auto-append.

### Step 5: Detect gravity candidates

Check whether the current session's work reveals a pattern that has recurred 3+ times:

- Did you do something manually that a script or validator could do?
- Did you apply judgment that has become routine enough to be a convention?
- Did you follow a multi-step procedure that could be simplified into a skill or tool?

In full mode: only note candidates for future `/gravity` evaluation.
In deep mode: evaluate each candidate using the `/gravity` procedure (recurrence, stability, cost-benefit).

### Step 6: Check convention lifecycle

Read `docs/conventions/registry.yaml` and identify conventions needing attention.

#### L0 convention staleness

For each L0 convention, check whether the enforcer has triggered in the last 90 days:

| Source | How to check |
|--------|--------------|
| verify.ts warnings | `grep -c '"warning".*"convention_id"' .scheduler/metrics/sessions.jsonl` |
| health-watchdog alerts | Check `.scheduler/health/` for recent alerts |
| warning-escalation entries | Check escalation log files |
| anomaly-detection triggers | `grep -c 'anomaly' .scheduler/metrics/sessions.jsonl` |

A convention is **potentially stale** if:
- No triggers in 90+ days, AND
- The convention addresses a problem that may no longer exist

Output for stale conventions:
```
Convention <id> (<name>): No triggers in 90+ days.
Consider: (a) verify problem still exists, (b) update description, (c) deprecate if obsolete.
```

#### L2 promotion readiness

For each L2 convention, check `promotion_criteria` field:

| Status | Condition | Output |
|--------|-----------|--------|
| Ready | `verifiable_by_code: true` AND trivial check | Flag for L0 promotion task |
| Blocked | Requires NLP/complex analysis | Note what's blocking |
| Partial | Already partially L0 | Document remaining gap |

Output for promotion candidates:
```
Convention <id>: Ready for L0 promotion.
Criteria: <promotion_criteria>
Task: Add <check> to <enforcer>.
```

#### Registry hygiene

Also check for:
- Missing required fields (`id`, `name`, `level`, `description`)
- Orphaned conventions (enforcer file no longer exists)
- Duplicated content across conventions

### Step 7: Check domain knowledge synthesis needs (deep mode only)

In deep mode, check whether any active project has accumulated enough experiment records to warrant domain knowledge synthesis. Skip this step in full mode.

**Procedure:**

1. For each active project, count completed experiments:
   ```
   grep -rl "^status: completed" projects/<project>/experiments/*/EXPERIMENT.md | wc -l
   ```

2. Check whether the project has a `knowledge.md`:
   ```
   ls projects/<project>/knowledge.md
   ```

3. If a project has **10+ completed experiments** AND **no `knowledge.md`** (or `knowledge.md` is older than 30 days while 5+ new experiments have completed since its last update):
   - Flag it as a domain synthesis candidate
   - Create a task in the project's `TASKS.md`:
     ```
     - [ ] Run domain knowledge synthesis [zero-resource]
       Why: Project has N completed experiments without a consolidated knowledge reference. Per feedback/feedback-domain-knowledge-consolidation.md.
       Done when: projects/<project>/knowledge.md exists compiling key domain findings from all completed experiments, with provenance links to source EXPERIMENT.md files.
       Priority: medium
     ```

4. If a project already has `knowledge.md` and <5 new experiments since last update, skip it.

**Rationale:** Domain knowledge accumulates across experiments but doesn't naturally consolidate. After 10+ experiments, searching individual records becomes impractical. Periodic synthesis into `knowledge.md` files provides the same benefit as review papers — making accumulated knowledge accessible without reading every source. See `projects/a-exp/feedback/feedback-domain-knowledge-consolidation.md`.

### Step 8: Check artifact complexity (deep mode only)

Measure line counts for high-read-frequency artifacts:

| Artifact | Threshold | Rationale |
|----------|-----------|-----------|
| `AGENTS.md` | >400 | Read every session |
| `projects/*/README.md` | >200 | Read during orient |
| `projects/*/TASKS.md` | >150 | Read during task selection |
| `.Codex/skills/*/SKILL.md` | See tiers below | Loaded on invocation |
| `infra/*/src/*.ts` | >500 | Maintainability |

**Tiered triggers for skills** (per `feedback/feedback-skill-growth-governance.md`):

| Tier | Threshold | Action |
|------|-----------|--------|
| Flag | >200 | Note in output; no task |
| Task | >300 | Create simplification task |
| Gate | >400 | Must simplify before adding content |

The gate prevents indefinite deferral — a 300-line task can be deprioritized, but a 400-line gate forces action at point of need.

For each artifact exceeding threshold: check TASKS.md for existing simplification task; create one if missing. Report in output.

### Step 9: Fleet output audit (full/deep only)

Audit recent fleet worker sessions against `projects/a-exp/plans/fleet-quality-audit-checklist.md`.

1. **Identify fleet sessions**: Read `.scheduler/metrics/sessions.jsonl` for `triggerSource: "fleet"` entries — last 24h (full) or 48h (deep).
2. **Automated checks (D2-D8)**: Read each session's `verification` object. Flag sessions with: `hasCommit: false` (D3), `hasLogEntry: false` (D2), `ledgerConsistent: false` (D7), `l2ViolationCount > 0` (D4). Fire-and-forget (D8) is already L0-enforced.
3. **Manual checks (D1, D5)**: For fleet sessions that modified TASKS.md:
   - D1: Spot-check 2-3 newly `[x]` tasks — does "Done when" match artifacts on disk?
   - D5: Check any new `[escalate:]` tags — is the escalation reason legitimate?
4. **Aggregate**: Compute pass rate per dimension. Flag dimensions with <70% pass rate.
5. **Report**: "Fleet audit: N sessions, M/N passed. [Failures by dimension if any]"
6. **Recommendations**: Pass rate <70% → recommend reducing FLEET_SIZE. Escalation rate >20% → recommend tighter task qualification. Recurring D1 failures → recommend stricter "Done when" requirements.

### Step 10: Act

For each compound opportunity, classify and act:

| Category | Criterion | Action |
|----------|-----------|--------|
| Direct update | Small, verifiable | Apply now |
| New task | Larger, needs design | Add to TASKS.md |
| Gravity candidate | Recurring pattern | Add task: "Run `/gravity` on: <pattern>" |
| Approval needed | Governance change | Write to APPROVAL_QUEUE.md |
| Evolution | Infra code change | Create `.pending-evolution.json` |

**Direct update rules:**
- Additions preferred over modifications (gotchas safer than rewrites)
- Self-contained updates (future agent understands without this session's context)
- Propagate changes to all locations (AGENTS.md, SOPs, skills) in same turn
- **Growth accounting**: When adding 10+ lines, identify lines to compress or remove. **Gate**: If target skill >400 lines, simplify before adding (run `/simplify` first).

## Output format

```
### Compound phase

**Learnings embedded:** <count>
<bulleted list or "none">

**Recommendations actioned:** <count>
<bulleted list or "none">

**Research questions surfaced:** <count>
<bulleted list or "none">

**Gravity candidates noted:** <count>
<bulleted list or "none">

**Convention lifecycle:** <count>
<bulleted list or "none">

**Fleet audit:** <N sessions, M/N passed> or "no fleet sessions"
<dimension failures if any>

**Tasks created:** <count>
<bulleted list or "none">
```

If no compound actions: `### Compound phase\nNo compound actions warranted this session.`

## Relationship to other skills

- **/gravity**: Evaluates whether a pattern should be formalized. `/compound` identifies candidates; `/gravity` evaluates them.
- **/postmortem**: Analyzes flawed outputs. `/compound` checks if postmortem recommendations were actioned.
- **/synthesize**: Interprets cross-session findings. `/compound` operates on single-session learnings.
- **/orient**: Session-start awareness. `/compound` session-end embedding — orient reads what compound wrote.
- **evolution.ts**: Applies infra code changes. `/compound` may generate `.pending-evolution.json`.

## Commit

If standalone (not SOP Step 5): commit changes with `git add <files> && git commit -m "compound: <summary>"`. Do not push. When invoked as SOP Step 5, the session's Step 6 handles the commit.

## Anti-patterns

- **Compound theater**: Trivial updates to show activity. If nothing learned, log "no compound actions".
- **Scope creep**: Executing the work that tasks describe. Compound creates tasks and embeds learnings — it does not do the work itself.
- **Ungrounded proposals**: Convention changes from single data point. Need 3× recurrence per `/gravity`.
- **Skipping**: Most common failure. Even "routine work" may have friction worth documenting.
