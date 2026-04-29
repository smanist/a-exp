# akari

Status: active
Priority: high
Mission: Maintain the trimmed OpenAkari core as a small, runnable agent research scaffold.
Done when: Scheduler, Slack, project memory, reports, budgets, and experiment tooling remain understandable and verified.

## Context

This support project tracks work on OpenAkari itself. The repo was trimmed to keep only the components the user identified as necessary:

- cron scheduler
- project creation with decomposed tasks
- automatic project extension/exploration through orient-style workflows
- repo memory
- experiment records and reports
- artifact management
- Slack
- lightweight budget fields and budget status reporting

Historical research projects and heavy governance history are intentionally removed from the core branch.

## Log

### 2026-04-29 (Trimmed repo to core surface)

Implemented the core trim plan on the `trim` branch. Removed historical decision records, old project artifacts, the old sample research projects/modules, worker-pool reference code, heavy budget audit tooling, and non-core docs. Rewrote the top-level operating docs and this support project around the retained runtime: scheduler, Slack, project memory, reports, lightweight budgets, and experiment tooling.

Important workspace note: several removed `.agents/skills/*` directories are protected by the local Codex skill mount and could not be physically deleted, so they were removed from git tracking and ignored. A fresh checkout of this branch will not contain those untracked local-only skill copies.

Verification:
- Pending final scheduler and Python checks after code-surface cleanup.

Files:
- `AGENTS.md`
- `README.md`
- `docs/`
- `projects/akari/`

## Open questions

- Should full Slack remain a reference package under `infra/scheduler/reference-implementations/slack`, or should it become the only active Slack implementation in a later cleanup?
