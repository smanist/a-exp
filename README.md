# a-exp Core

a-exp is a small repository interface for recurring AI research sessions. It keeps the parts that make agents useful over time:

- cron-style scheduled sessions
- Slack operator interface
- project memory and decomposed tasks
- project scaffolding
- experiment records and reports
- lightweight budget status
- artifact conventions

It is not a large framework. The repo is the interface: agents read and update plain-text files, then use the scheduler and experiment tooling when work needs to run.

a-exp is based on a heavily modified and trimmed fork from [openakari](https://github.com/victoriacity/openakari).

## Quick Start

```bash
cd infra/scheduler
npm install
npm run build
cd ../..

./a-exp add --name "work-cycle" --cron "0 * * * *" --message-default --model gpt-5.2
./a-exp start
```

Slack is optional. Configure these variables to enable it:

```bash
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
SLACK_USER_ID=...
```

## What Is Included

| Component | Purpose |
|---|---|
| `AGENTS.md` | Operating contract for agents in this repo |
| `infra/scheduler/` | Cron scheduler, session launch, Slack, status, reports |
| `infra/experiment-runner/` | Fire-and-forget experiment execution with artifacts |
| `infra/experiment-validator/` | Experiment record validation |
| `projects/a-exp/` | Support project for maintaining a-exp itself |
| `examples/my-research-project/` | Minimal project scaffold |
| `docs/schemas/` | File schemas for tasks, logs, budgets, experiments |
| `docs/conventions/` | Retained conventions for memory, tasks, artifacts, provenance |

## Project Shape

```text
projects/<project>/
  README.md
  TASKS.md
  budget.yaml
  ledger.yaml
  plans/
  experiments/<experiment-id>/EXPERIMENT.md

modules/<module>/
  artifacts/<experiment-id>/
```

Project directories hold memory and coordination. Module directories hold code and heavy outputs.

## Scheduler

The `./a-exp` wrapper points at the scheduler CLI. Retained commands are:

```bash
./a-exp start
./a-exp stop
./a-exp add --name work-cycle --cron "0 * * * *" --message-default
./a-exp list
./a-exp run <job-id>
./a-exp status
./a-exp heartbeat
./a-exp check-health --notify
```

Reports are generated with:

```bash
cd infra/scheduler
npx tsx src/report/run-report.ts --type project --project a-exp
```

## Budget Support

Budget support is informational. `budget.yaml` declares limits and `ledger.yaml` records usage. Reports summarize those repo files. The trimmed core does not include external provider auditing or provider-backed budget enforcement.

## License

MIT. See `LICENSE`.
