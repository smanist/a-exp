---
name: project
description: "Manage research project setup and scope changes — propose new projects, scaffold new projects, or augment existing projects"
complexity: very_high
model-minimum: frontier
disable-model-invocation: false
allowed-tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Write", "Bash(git diff *)", "Bash(git log *)", "Bash(git status)", "Bash(git add *)", "Bash(git commit *)", "Bash(mkdir -p *)"]
argument-hint: "propose [topic] | scaffold <description> | augment <project> <request>"
interview: true
---

# /project <mode> [argument]

Unified skill for project setup and scope changes. Three modes:

- **`/project propose [topic]`** — Agent-initiated. Scans the repo for research gaps, assesses whether a gap warrants a project, and writes a formal proposal for PI review. Proposals require approval to activate. If topic is omitted, scans for candidate gaps first.

- **`/project scaffold <description>`** — Human-initiated. Interactive interview to understand what the human wants, then scaffolds the project directory with all required files. No approval needed — the human requesting it has authority.

- **`/project augment <project> <request>`** — Human-initiated. Interactive workflow to extend an existing project's scope with new context, tasks, plans, or resource records while keeping the project's mission and done-when fixed.

**When to use which mode:**
- You identified a research gap and want to propose an investigation → `propose`
- A human asked you to set up a new project → `scaffold`
- A human asked you to extend or refine an existing project → `augment`

---

## Mode: propose

Agent-initiated project proposal. All inputs are repo-resident (experiment findings, open questions, literature gaps, operational patterns).

### Principles

1. **Ground in evidence, not speculation.** Every claim about a gap must cite a specific source: an experiment finding, an operational pattern, a literature gap, an open question.

2. **Research questions over implementation requests.** A proposal must center on a question that produces knowledge when answered. "Build a dashboard" is not a project — "Does real-time visualization reduce PI intervention rate?" is.

3. **Proportionate scope.** Prefer focused investigations over broad surveys. A project that answers one specific question well is more valuable than one that vaguely addresses five.

4. **Explicit uncertainty.** State what you don't know. If feasibility depends on an untested assumption, propose a pilot step.

### Step 1: Identify candidate gaps

If a topic was provided, skip to Step 2. Otherwise, scan these sources:

1. **Open questions** — Read `## Open questions` sections in all active project READMEs. Look for questions not addressed by existing experiments.
2. **Experiment recommendations** — Scan completed `EXPERIMENT.md` files for unactioned recommendations (Recommendations, Proposed solutions, Next steps) beyond current project scope.
3. **Cross-session patterns** — Check `.scheduler/metrics/sessions.jsonl` for recurring operational issues.
4. **Literature gaps** — Check `literature/synthesis.md` files for gaps between existing literature and current questions.
5. **Roadmap gaps** — Read `docs/roadmap.md` and `projects/a-exp/plans/long-term-roadmap.md` for capability gaps.

Select the single most promising candidate — strongest evidence and clearest path to actionable findings.

### Step 2: Assess the gap

Evaluate whether the gap warrants a full project:

**Project-worthy if:**
- Investigation spans multiple experiments or sessions
- Question is orthogonal to all existing project missions
- Findings would inform system-wide decisions
- Dedicated budget, timeline, and mission add value

**Better as an existing-project task if:**
- Natural extension of an active project's mission
- Fits within 1-2 experiments
- Findings primarily benefit one project

**Better as an infrastructure task if:**
- Primarily code or configuration changes
- Success is binary, not a spectrum of findings

State your assessment explicitly. If the gap is better handled as a task, write the task instead.

### Step 3: Research context

1. **Check existing knowledge.** Read relevant READMEs, experiment records, and decision records.
2. **Check literature.** Use WebSearch to find 3-5 relevant papers. Fetch URLs to verify they exist.
3. **Check feasibility.** What tools, APIs, data, or compute are needed? Available or approval-needed?
4. **Identify CI layers.** Which layers does this investigation address?

### Step 4: Write the proposal

Save to `projects/a-exp/proposals/<slug>.md`:

```markdown
# Project Proposal: <Title>

Date: YYYY-MM-DD | Status: proposed (requires PI approval)

## Research question
<One sentence, falsifiable.>

## Gap evidence
<Specific evidence citing file paths or URLs.>

## CI layers
<Which layers are involved.>

## Proposed investigation
Mission: <One sentence.> | Done when: <Verifiable condition.>
Method: <3-5 steps.> | Expected findings: <What this produces.>

## Feasibility
Resources: | Resource | Estimate | Available? |
Dependencies: <What must be true.> | Risks: <What could go wrong.>

## Scope
In: <bulleted> | Out: <bulleted>

## Alternatives & Roadmap
Alternatives: <Other approaches.> | Roadmap: <Link to docs/roadmap.md.>
```

### Step 5: Self-review

Check against:
1. Is the research question falsifiable?
2. Is the scope bounded?
3. Is gap evidence concrete (every claim cites a source)?
4. Is cost proportionate to expected knowledge?
5. Does "Done when" pass the agent-verifiability test?

Revise if any check fails.

### Step 6: Save and commit

Follow `docs/sops/commit-workflow.md`. Commit message: `project propose: <title> — awaiting PI approval`

Add an entry to `APPROVAL_QUEUE.md` under Pending:
```
### YYYY-MM-DD — New project proposal: <title>
Project: a-exp
Type: structural
Request: Activate new research project based on proposal at `projects/a-exp/proposals/<slug>.md`
Context: <1-2 sentence summary of gap evidence>
```

---

## Mode: scaffold

Human-initiated project creation. Interactive — requires human input at multiple steps. Do not proceed past interview questions until the human has answered.

### Human Input Protocol (Deep Work Sessions)

When running in a deep work session (autonomous, headless), use the question marker protocol to request human input:

1. **Format your questions** using the `[QUESTION: <id>]...[/QUESTION]` marker
2. **Include metadata** to enable continuation detection
3. **End the session** after posting — a new session will spawn when the human replies

**Marker format:**
```
[QUESTION: project-scaffold-<unique-id>]
skill="project"
mode="scaffold"

1. What is the research question or objective?
2. What are the success criteria?
[/QUESTION]
```

The marker will be detected by the scheduler, the questions posted to Slack, and the session ended. When the human replies, a new deep work session will spawn with the answers in the thread context.

**Continuation detection:** When resuming, check the thread context for human answers. Parse the previous messages for responses to your questions and continue from where you left off.

### Step 1: Parse the initial description

Extract from the provided description:
- **Topic**: What domain or question?
- **Motivation**: Why does the human want this?
- **Scope signals**: Scale, timeline, or resource hints?
- **Research vs. operational**: Investigation (produces knowledge) or infrastructure (produces tooling)?

Summarize in 2-3 sentences. Present to the human for confirmation before proceeding.

### Step 2: Cross-project knowledge check

**Before the interview, search for relevant prior work.** This prevents suggesting approaches that contradict existing knowledge.

Search in parallel:
1. **Similar task patterns** — `grep -r "collect.*images\|user.*image\|data.*access" projects/*/experiments/*/EXPERIMENT.md projects/*/*.md 2>/dev/null | head -20`
2. **Infrastructure docs** — Check for `production-code.md`, `*-data-access.md`, `infrastructure-audit.md` in project directories
3. **Recent decisions** — `projects/<project>/decisions/*.md` and `decisions/*.md` for constraints

If relevant knowledge exists:
- Note it in your working context
- During interview, ask: "I found existing work on [topic] in [project]. Should this project leverage that?"
- If the human confirms, incorporate the knowledge into scope/tasks

**Example:** When scaffolding a project that needs user image collection, the bot should search for existing `user-image-data-access.md` or similar docs in other projects and ask whether to use the same approach.

### Step 3: Interview

Ask clarifying questions to fill gaps. Adapt to what the description already covers.

**Required information (ask if missing):**

1. **Research question or objective** — "What specific question are you trying to answer?" or "What capability are you trying to build?"
2. **Success criteria** — "How will we know when this is done?" Push for specificity.
3. **Scope boundaries** — "What is in scope?" and "What should we exclude?"
4. **Resources and constraints** — LLM API calls, GPU, external APIs? Budget or deadline?

**Optional questions (ask if relevant):**

5. **CI layers** — only if the human is familiar with the CI framework
6. **Connection to existing work** — check `projects/` for potential connections
7. **Initial tasks** — does the human have first steps in mind?
8. **Task granularity** — should the scaffold use coarse, mid-sized, fine, or manually provided task splits?
9. **Context** — background reading, prior art, existing data?

**Interview protocol:**
- Ask in batches of 2-3, not all at once
- Summarize after each batch, identify remaining gaps
- Accept terse answers — fill in reasonable defaults and note assumptions
- Two rounds is usually sufficient, three is the maximum

### Step 4: Check existing landscape

Before creating the project:
1. Read all `projects/*/README.md` — check for mission overlap
2. Check `projects/a-exp/proposals/` for pending proposals on the same topic
3. If overlap exists: "This overlaps with `<project>` which has mission: `<mission>`. New project or tasks within existing one?"

Wait for response before proceeding.

### Step 5: Scaffold the project

Create `projects/<slug>/` and register a matching execution module at `modules/<slug>/` in `modules/registry.yaml`.

**README.md** — following AGENTS.md project README schema:
```markdown
# <Project Title>

Status: active
Mission: <one-sentence objective — synthesized from interview>
Done when: <verifiable condition — from success criteria>

## Context

<3-5 sentences from motivation, research question, and scope.>

## Log

### YYYY-MM-DD — Project created

Project initiated via `/project scaffold`. <1-2 sentences from interview.>

Sources: none (project creation)

## Open questions

- <any open question from the interview>
```

**TASKS.md** — initial tasks using AGENTS.md task schema:
```markdown
# <Project Title> — Tasks

<Human-provided tasks, or 2-3 mid-sized bootstrapping tasks. If the human requested finer or coarser decomposition, honor that request when each task remains bounded and verifiable. Use multi-bullet `Done when` criteria when one task has several acceptance checks.>

Research project:
- [ ] Establish research context and first experiment design
- [ ] Run and report first experiment

Operational project:
- [ ] Define requirements, constraints, and implementation plan
- [ ] Implement and verify the first usable capability
```

**budget.yaml + ledger.yaml** — only if the human indicated resource consumption.

**modules/registry.yaml** — append:
```yaml
- project: <slug>
  module: <slug>
  path: modules/<slug>
  type: submodule
```

### Step 6: Present for review

Show the human:
```
Created project: <title>
Directory: projects/<slug>/

Files:
- README.md — Mission: <summary>
- TASKS.md — <N> initial tasks
- budget.yaml — <resource summary> (if created)
- modules/registry.yaml — module path `modules/<slug>`

Does this look right? I can adjust anything before committing.
```

Wait for confirmation. Apply changes if requested.

### Step 7: Commit

Follow `docs/sops/commit-workflow.md`. Commit message: `project scaffold: <title>`

### Step 8: Log in a-exp project

Add a log entry to `projects/a-exp/README.md`:
```markdown
### YYYY-MM-DD — New project: <title>

Created `projects/<slug>/` via `/project scaffold`. Mission: <one-sentence>.

Sources: projects/<slug>/README.md
```

---

## Mode: augment

Human-initiated existing-project extension. Interactive — requires human input when the request is ambiguous or would change the project's boundaries.

### Human Input Protocol (Deep Work Sessions)

When running in a deep work session (autonomous, headless), use the same question marker pattern as scaffold:

```
[QUESTION: project-augment-<unique-id>]
skill="project"
mode="augment"

1. Which existing project should be extended?
2. What new capability, question, or workstream should be added?
[/QUESTION]
```

Resume when the human replies with the missing details.

### Step 1: Parse the request

Extract:
- **Target project** — existing `projects/<slug>/`
- **Requested augmentation** — new question, capability, experiment stream, or operational work
- **Why now** — motivation, blocker, or new information
- **Scope pressure** — whether this still fits the current mission and done-when

Summarize in 2-3 sentences before editing anything.

### Step 2: Load current project state

Read the target project's:
1. `README.md` — mission, done-when, context, recent log, open questions
2. `TASKS.md` — current task inventory and blocked state
3. `plans/` or `experiments/` entries relevant to the requested augmentation
4. `budget.yaml` / `ledger.yaml` if the new work may consume resources
5. `modules/registry.yaml` only if execution ownership or module linkage may need updates

### Step 3: Assess fit before proceeding

**Proceed with augment if:**
- The request is a natural extension of the project's existing mission
- The current `Done when:` still makes sense unchanged
- The new work can be expressed as added context, tasks, plans, experiments, or budget records

**Do not use augment if:**
- The request would change the project's mission or `Done when:` (they are immutable once set)
- The work is orthogonal enough that it should be a new project
- The request is really an implementation task that should just be added to `TASKS.md` without project restructuring

If the request does not fit, say so explicitly and redirect to `scaffold`, `propose`, or ordinary task editing as appropriate.

### Step 4: Interview for missing details

Ask only for the missing pieces. Common gaps:

1. **Outcome** — what should be newly true after the augmentation?
2. **Success signal** — what concrete artifact or milestone should exist?
3. **Scope boundaries** — what should remain out of scope?
4. **Resource implications** — new budget, external APIs, GPU, or approvals?
5. **Execution shape** — just tasks, or also a plan, experiment scaffold, or module registration change?

Interview protocol:
- Ask in batches of 2-3 questions
- Summarize assumptions after each batch
- Stop after enough information exists to make a bounded update

### Step 5: Apply the augmentation

Update only the files needed by the request:

- **`projects/<project>/README.md`** — add context, open questions, or a dated log entry describing the augmentation
- **`projects/<project>/TASKS.md`** — add or rewrite tasks using the task schema; never mark partial work as complete
- **`projects/<project>/plans/<name>.md`** — add a plan when the augmentation introduces a multi-step workstream
- **`projects/<project>/budget.yaml` / `ledger.yaml`** — add only if the new work changes resource accounting
- **`modules/registry.yaml`** — touch only if the project needs a new or corrected execution-module mapping

Prefer minimal deltas. Augment should extend the project, not respecify it from scratch.

### Step 6: Present the delta

Show the human a concise summary:

```text
Updated project: <project>

Planned changes:
- README.md — <what changed>
- TASKS.md — <new tasks>
- plans/<name>.md — <if added>
- budget.yaml — <if changed>

Does this augmentation look right before commit?
```

Wait for confirmation. Apply requested adjustments.

### Step 7: Commit

Follow `docs/sops/commit-workflow.md`. Commit message: `project augment: <project>`

### Step 8: Log completion

Add a dated log entry to the target project's `README.md` summarizing what was added and why.

---

## Constraints (all modes)

- **AGENTS.md compliance.** All generated files follow AGENTS.md schemas exactly. Mission and Done-when are immutable once set.
- **Deduplication.** Always check for overlap with existing projects before creating.
- **No push.** Pushing is handled at the session lifecycle level, not per-skill.
