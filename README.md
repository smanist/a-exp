# a-exp Core

a-exp is a small repository interface for recurring AI research sessions. It keeps the parts that make agents useful over time:

- cron-style scheduled sessions
- Slack operator interface
- project memory and bounded task units
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

./a-exp init --project my-research-project
./a-exp add
./a-exp start
```

For local use, create project repos parallel to this checkout so the reusable
agent kit resolves through `../a-exp`:

```text
Repos/
  a-exp/
  my-research-project/
```

`a-exp init` symlinks `.agents` and `docs` from the sibling a-exp repo, records
the kit commit in `.a-exp/kit.lock.yaml`, and keeps project memory local.
`a-exp` discovers the workspace by walking upward for `.a-exp/config.yaml`; pass
`--repo <dir>` when a script or daemon should target a specific repo.
`a-exp init` also writes scheduler defaults so `a-exp add` creates an hourly
work-cycle job unless flags override the defaults.

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
| `.a-exp/config.yaml` | Workspace anchor and layout metadata |
| `.a-exp/kit.lock.yaml` | Sibling kit source and commit recorded at init time |
| `.agents/skills/` | Agent skills, symlinked from `../a-exp` in local project repos |
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
modules/registry.yaml
```

Project directories hold memory and coordination. Module directories hold code and heavy outputs.

Scheduler runtime files are workspace-local and ignored by git:

```text
.a-exp/jobs.json
.a-exp/logs/
.a-exp/metrics/
.a-exp/channel-modes.json
.a-exp/model-preference.json
```

Initialized project repos keep `.a-exp/config.yaml` and
`.a-exp/kit.lock.yaml` durable while ignoring the runtime files above.

## Scheduler

The `./a-exp` wrapper points at the scheduler CLI. Retained commands are:

```bash
./a-exp start
./a-exp stop
./a-exp project [description-file]
./a-exp kanban [project] --output-dir reports/kanban
./a-exp kanban --quick [project]
./a-exp packet <project> <target-package> [instructions...]
./a-exp add
./a-exp add <project>
./a-exp run <job-id>
./a-exp remove <job-id>
./a-exp enable <job-id>
./a-exp disable <job-id>
./a-exp status
./a-exp heartbeat
./a-exp check-health --notify
```

`./a-exp start` launches the scheduler as a background daemon and writes daemon
output to `.a-exp/logs/daemon.log`. Use `./a-exp start --foreground` when
developing or when you want startup and runtime logs in the current terminal.

`./a-exp add` reads default options from `.a-exp/config.yaml` under
`scheduler.add_defaults`. Explicit flags such as `--cron`, `--every`, `--model`,
`--message`, and `--max-duration-ms` override those defaults. A positional
project name is shorthand for `--name <project> --message-project <project>`,
so `./a-exp add my-research-project` creates a job named `my-research-project`
that runs against `projects/my-research-project`.

`./a-exp status` is the main operator view. Its jobs section includes the
job-management fields needed by `run`, `enable`, `disable`, and `remove`: id,
name, enabled state, schedule, human-readable next run, last status, and run
count.

`./a-exp project` opens a temporary project description file in VS Code and runs
the project skill after the editor closes. Pass `./a-exp project <file>` to use
an existing description file.

`./a-exp kanban --quick` runs the deterministic kanban generator directly,
without launching an agent session, and writes one combined
`reports/kanban/_quick.md` file.

Global workspace override:

```bash
./a-exp --repo /path/to/project-repo status
```

Reports are generated with:

```bash
cd infra/scheduler
npx tsx src/report/run-report.ts --repo ../.. --type project --project a-exp
```

## Self-Hosting Development

This repository is also an initialized a-exp workspace for maintaining a-exp
itself. The tracked `.a-exp/config.yaml` identifies the source checkout as the
workspace; generated runtime state under `.a-exp/` remains ignored.

## Budget Support

Budget support is informational. `budget.yaml` declares limits and `ledger.yaml` records usage. Reports summarize those repo files. The trimmed core does not include external provider auditing or provider-backed budget enforcement.

## License

MIT. See `LICENSE`.
