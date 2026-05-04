# AGENTS.md

This repo is the trimmed a-exp core: a small, file-based operating system for recurring agent research sessions.

## What To Preserve

a-exp now keeps only these responsibilities:

- scheduled agent sessions through `infra/scheduler/`
- Slack operator interface and notifications
- repo memory through `projects/<project>/`
- project scaffolding and bounded task units
- experiment records, reports, and lightweight artifact conventions
- informational budget status from `budget.yaml` and `ledger.yaml`

If a change does not support one of those responsibilities, keep it out of the core.

## Repository Layout

- `projects/<project>/README.md` records mission, context, log, and open questions.
- `projects/<project>/TASKS.md` records bounded next actions.
- `projects/<project>/budget.yaml` declares lightweight resource limits when needed.
- `projects/<project>/ledger.yaml` records declared usage when needed.
- `projects/<project>/plans/` holds non-trivial plans.
- `projects/<project>/experiments/<id>/EXPERIMENT.md` holds experiment records.
- `modules/<module>/` holds project-owned code and heavy artifacts.
- `modules/<module>/artifacts/<experiment-id>/` holds run outputs.
- `infra/scheduler/` holds cron, Slack, session launch, status, and reports.
- `infra/experiment-runner/` launches long-running experiments out of process.
- `infra/experiment-validator/` validates experiment records.

## Work Cycle

1. Read the relevant project `README.md` and `TASKS.md`.
2. Select an unblocked task with concrete `Done when` criteria.
3. Make the smallest cohesive change that satisfies the task.
4. Verify with the narrowest useful tests or checks.
5. Update the project log with what changed and the exact verification command.
6. Commit the completed logical unit.

For user-directed work, follow the user's request first. Do not invent unrelated autonomous work.

## Recording Rules

- Non-obvious discovery -> record it in the relevant project file in the same turn.
- Decision -> record it in a project log or plan before relying on it later.
- Non-trivial plan -> write it under `projects/<project>/plans/`.
- Experiment -> create or update `projects/<project>/experiments/<id>/EXPERIMENT.md`.
- Verification -> log the exact command and result in the project README.
- Open question -> add it to the project's `## Open questions` section.

The test is simple: a fresh agent reading the repo should know the current state without the old conversation.

## Tasks

Tasks use this shape:

```markdown
- [ ] Imperative task title
  Why: Why this matters.
  Done when: Mechanically verifiable completion condition.
  Priority: high|medium|low
```

Tasks may also use multiple `Done when` criteria when a mid-sized task has several acceptance checks:

```markdown
- [ ] Imperative task title
  Why: Why this matters.
  Done when:
  - Mechanically verifiable completion condition.
  - Another mechanically verifiable completion condition.
  Priority: high|medium|low
```

Prefer mid-sized coherent tasks by default. Split tasks only when the pieces are independently useful, independently verifiable, require separate approvals or resources, or are unlikely to fit in one agent session. If the user asks for finer or coarser decomposition during scaffolding or task creation, honor that request when each resulting task remains bounded and verifiable.

Use `[blocked-by: ...]` only for conditions outside agent control, such as missing credentials or explicit human approval.

## Budgets

Budget support is intentionally lightweight. `budget.yaml` declares limits; `ledger.yaml` records usage. Reports may summarize declared consumption, but the trimmed core does not audit external providers or enforce provider-backed accounting.

## Experiments

Do not supervise long-running experiments in an agent session. Launch them through:

```bash
python infra/experiment-runner/run.py --detach --artifacts-dir modules/<module>/artifacts/<experiment-id> --project-dir projects/<project> --max-retries <N> --watch-csv <output-csv> --total <N> <experiment-dir> -- <command...>
```

Keep heavy outputs under `modules/<module>/artifacts/`, not under `projects/`.

## Scheduler And Slack

The public scheduler entrypoint is `./a-exp`.

Retained commands:

- `start`, `stop`
- `add`, `list`, `remove`, `run`, `enable`, `disable`
- `status`, `heartbeat`, `check-health`

Slack configuration:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_USER_ID`
- optional `SLACK_CHAT_MODEL`

The scheduler must still run without Slack tokens; Slack functions should degrade to no-ops.

## Testing

Use focused checks:

- Scheduler build: `cd infra/scheduler && npm run build`
- Scheduler tests: run retained targeted Vitest suites.
- Experiment tools: `python -m pytest infra/experiment-runner infra/experiment-validator`

Do not keep tests for deleted subsystems.
