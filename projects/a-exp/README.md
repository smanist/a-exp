# a-exp

Status: active
Priority: high
Mission: Maintain the trimmed a-exp core as a small, runnable agent research scaffold.
Done when: Scheduler, Slack, project memory, reports, budgets, and experiment tooling remain understandable and verified.

## Context

This support project tracks work on a-exp itself. The repo was trimmed to keep only the components the user identified as necessary:

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

### 2026-04-29 (Fixed status daemon detection)

Changed `a-exp status` to derive daemon state from the workspace `.a-exp/scheduler.pid` lockfile instead of always reporting `stopped`. The pid check now treats `EPERM` from `process.kill(pid, 0)` as evidence that the process exists.

Verification:
- `cd infra/scheduler && npm run build && npm test`: passed, 2 files and 9 tests.
- `cd infra/scheduler && node dist/cli.js --repo /tmp/a-exp-status-test.DcClTJ/project-repo status` after writing PID `1` to `.a-exp/scheduler.pid`: reported `Daemon: running`.

Files:
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/instance-guard.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-04-29 (Expanded init into a local workspace kit)

Updated `a-exp init` for local distributed project repos. New project repos must now be parallel to an `a-exp/` checkout, and init creates `.agents -> ../a-exp/.agents` plus `docs -> ../a-exp/docs` so skills and docs remain locally shared. Init also writes `.a-exp/kit.lock.yaml`, a fuller `AGENTS.md`, `modules/registry.yaml`, `ledger.yaml`, `APPROVAL_QUEUE.md`, project/module README files, durable `.gitkeep` placeholders, and a workspace `.gitignore`.

Verification:
- `cd infra/scheduler && npm run build && npm test`: passed, 2 files and 8 tests.
- `cd infra/scheduler && node dist/cli.js --repo /tmp/a-exp-sibling-init.ZUtKJd/project-repo init --project demo`: created symlinked `.agents`/`docs`, kit lock, registry, placeholders, and project scaffold in a temp sibling layout.
- `readlink /tmp/a-exp-sibling-init.ZUtKJd/project-repo/.agents`: printed `../a-exp/.agents`.
- `readlink /tmp/a-exp-sibling-init.ZUtKJd/project-repo/docs`: printed `../a-exp/docs`.

Files:
- `.a-exp/config.yaml`
- `.gitignore`
- `README.md`
- `docs/`
- `infra/scheduler/`
- `projects/a-exp/README.md`

### 2026-04-29 (Made a-exp target initialized project repos)

Implemented the generic project-repo workflow. The scheduler CLI now resolves a workspace through `--repo <dir>` or upward discovery of `.a-exp/config.yaml`, adds `a-exp init --project <name>`, and writes scheduler runtime state under workspace-local `.a-exp/` paths. The source checkout remains self-hosting through the tracked `.a-exp/config.yaml`; generated `.a-exp` runtime files stay ignored.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 7 tests.
- `cd infra/scheduler && node dist/cli.js --repo /tmp/a-exp-workspace-test.1b07ix init --project demo`: created the project scaffold under the temp repo.
- `cd infra/scheduler && node dist/cli.js --repo /tmp/a-exp-workspace-test.1b07ix add --name work-cycle --every 60000 --message-default`: created `.a-exp/jobs.json` in the temp repo.
- `cd infra/scheduler && node dist/cli.js --repo /tmp/a-exp-workspace-test.1b07ix list`: listed the temp repo job.
- `cd infra/scheduler && node dist/cli.js --repo /tmp/a-exp-workspace-test.1b07ix status`: reported one enabled job.
- `cd /tmp/a-exp-workspace-test.1b07ix/projects/demo && node /Users/daninghuang/Repos/a-exp/infra/scheduler/dist/cli.js list`: auto-discovered the temp repo workspace and listed the job.
- `./a-exp status`: passed in the self-hosting source repo.

Files:
- `.a-exp/config.yaml`
- `.gitignore`
- `README.md`
- `docs/`
- `infra/scheduler/`
- `projects/a-exp/README.md`

### 2026-04-29 (Renamed previous identity to a-exp)

Renamed the remaining previous project identity, module, CLI wrapper, scheduler package/bin metadata, Slack command examples, docs, tracked skills, and support paths to `a-exp`.

Verification:
- `rg -n --hidden -g '!.git' -i "a[k]ari"`: no matches.
- `find . -path ./.git -prune -o -iname '*a[k]ari*' -print`: no matches.
- `cd infra/scheduler && npm run build`: passed after installing declared scheduler dependencies with `npm install --no-package-lock`.
- `cd infra/scheduler && npm test`: passed, 2 files and 3 tests.
- `python -m pytest infra/experiment-runner infra/experiment-validator`: passed, 232 tests.
- `./a-exp`: printed the renamed scheduler CLI help.

Files:
- `a-exp`
- `AGENTS.md`
- `README.md`
- `.agents/skills/`
- `docs/`
- `infra/`
- `modules/a-exp/`
- `projects/a-exp/`

### 2026-04-29 (Trimmed repo to core surface)

Implemented the core trim plan on the `trim` branch. Removed historical decision records, old project artifacts, the old sample research projects/modules, worker-pool reference code, heavy budget audit tooling, and non-core docs. Rewrote the top-level operating docs and this support project around the retained runtime: scheduler, Slack, project memory, reports, lightweight budgets, and experiment tooling.

Important workspace note: several removed `.agents/skills/*` directories are protected by the local Codex skill mount and could not be physically deleted, so they were removed from git tracking and ignored. A fresh checkout of this branch will not contain those untracked local-only skill copies.

Verification:
- Pending final scheduler and Python checks after code-surface cleanup.

Files:
- `AGENTS.md`
- `README.md`
- `docs/`
- `projects/a-exp/`

## Open questions

- Should full Slack remain a reference package under `infra/scheduler/reference-implementations/slack`, or should it become the only active Slack implementation in a later cleanup?
