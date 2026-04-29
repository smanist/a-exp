# Design

a-exp Core treats each initialized project repository as the durable memory for
recurring agent sessions.

## Premise

LLM sessions are stateless. The repo stores what a continuing research assistant needs to know:

- project missions and logs
- decomposed tasks
- plans and decisions
- experiment records
- artifact locations
- lightweight budgets

The scheduler and Slack interface are operational helpers around that memory
layer. The CLI implementation may be installed elsewhere; the workspace repo is
selected by `--repo <dir>` or by discovering `.a-exp/config.yaml` from the
current directory.

## Principles

1. Plain text first: Markdown and YAML are easy for humans, agents, and git.
2. Projects are memory: `projects/<project>/` contains coordination and findings.
3. Modules are execution: `modules/<module>/` contains code and heavy artifacts.
4. Shared tools live in `infra/`.
5. Grow structure only when a real project needs it.
6. Keep the core small enough that a new agent can read it quickly.
7. Keep runtime scheduler state under `.a-exp/`; commit only
   `.a-exp/config.yaml` as the workspace anchor.

## Retained Runtime

The scheduler provides:

- cron or interval jobs
- persisted job state
- local session launch
- optional Slack DM/operator interface
- status and reports

Experiment tooling provides:

- detached execution
- progress records
- artifact placement
- experiment record validation

Budget tooling is deliberately lightweight: reports read `budget.yaml` and `ledger.yaml`; no external provider audit is part of the core.
