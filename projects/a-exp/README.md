# a-exp

Status: active
Priority: high
Mission: Maintain the trimmed a-exp core as a small, runnable agent research scaffold.
Done when: Scheduler, Slack, project memory, reports, budgets, and experiment tooling remain understandable and verified.

## Context

This support project tracks work on a-exp itself. The repo was trimmed to keep only the components the user identified as necessary:

- cron scheduler
- project creation with bounded task units
- automatic project extension/exploration through orient-style workflows
- repo memory
- experiment records and reports
- artifact management
- Slack
- lightweight budget fields and budget status reporting

Historical research projects and heavy governance history are intentionally removed from the core branch.

## Log

### 2026-05-14 (Removed scheduler list command)

Removed `a-exp list` from the public scheduler CLI, help text, docs, and
scaffolded workspace instructions. `a-exp status` remains the consolidated
operator view, and its job rows now include id, name, enabled state, schedule,
raw next run timestamp, last status, and run count, including the `last: never
(0 runs)` display for jobs that have not run.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 25 tests.
- `./a-exp list`: failed as expected with `Unknown command: list`.
- `./a-exp status`: passed, printed daemon/session/experiment/job summary.

Files:
- `AGENTS.md`
- `README.md`
- `infra/scheduler/README.md`
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/core.test.ts`
- `infra/scheduler/src/status.ts`
- `infra/scheduler/src/workspace.ts`
- `projects/a-exp/README.md`

### 2026-05-14 (Merged job list details into status)

Changed the `a-exp status` jobs section to use the compact job-management row
from `a-exp list`, including job id, name, enabled state, schedule, and raw next
run timestamp. The status header remains the broad operator summary for daemon,
sessions, experiments, and job counts.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 25 tests.

Files:
- `README.md`
- `infra/scheduler/README.md`
- `infra/scheduler/src/status.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-14 (Added project shorthand for scheduler jobs)

Changed `a-exp add <project>` to behave like
`a-exp add --name <project> --message-project <project>`, while preserving
explicit flag precedence over the shorthand. The add success output now prints
the schedule details, model, inferred project, cwd, max duration, enabled state,
and next run timestamp.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 24 tests.

Files:
- `README.md`
- `infra/scheduler/README.md`
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-14 (Committed initialized workspaces)

Changed `a-exp init` so the target folder is initialized as a git repository
when it is not already the repo root. The init flow now stages only the scaffold
paths it creates and commits them as `Initialize a-exp workspace for <project>`,
leaving pre-existing user files untouched.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 22 tests.

Files:
- `infra/scheduler/src/workspace.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-14 (Added scheduler add defaults)

Added workspace-level scheduler defaults under `.a-exp/config.yaml`
`scheduler.add_defaults`, and changed `a-exp add` to use those defaults for
name, schedule, prompt, model, cwd, and max duration when explicit CLI flags are
omitted. `a-exp init` now writes the defaults for new workspaces, so a plain
`a-exp add` creates the default hourly work-cycle job. Explicit add flags still
override config values.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 22 tests.

Files:
- `.a-exp/config.yaml`
- `README.md`
- `infra/scheduler/README.md`
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/core.test.ts`
- `infra/scheduler/src/workspace.ts`
- `projects/a-exp/README.md`

### 2026-05-13 (Made quick kanban output a single file)

Changed deterministic quick kanban output so `a-exp kanban --quick` writes one
combined Markdown file, `_quick.md`, instead of one file per project. The kanban
generator gained `--single-output FILE` for direct use, and the quick CLI path
always passes `--single-output _quick.md`.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 21 tests.
- `python .agents/skills/kanban/scripts/generate_kanban.py --repo-root . --single-output _quick.md --dry-run --max-cost-items 1 --max-result-bullets 1`: passed, printed one `_quick.md` dry-run block.
- `./a-exp kanban --quick --output-dir /private/tmp/a-exp-kanban-quick-check --max-cost-items 1 --max-result-bullets 1`: passed, wrote `/private/tmp/a-exp-kanban-quick-check/_quick.md`.
- `find /private/tmp/a-exp-kanban-quick-check -maxdepth 1 -type f -print | sort`: passed, listed only `_quick.md`.

Files:
- `.agents/skills/kanban/SKILL.md`
- `.agents/skills/kanban/scripts/generate_kanban.py`
- `README.md`
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-13 (Added deterministic kanban quick mode)

Added `a-exp kanban --quick` as a direct deterministic path to the kanban
helper script, bypassing the agent-backed kanban skill job. The quick mode
supports the existing kanban options, `--dry-run`, and an optional project
filter. The generator script now accepts a positional project name so scoped
quick runs only emit the requested `<project>.md`.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 21 tests.
- `python .agents/skills/kanban/scripts/generate_kanban.py a-exp --repo-root . --dry-run --max-cost-items 1 --max-result-bullets 1`: passed, printed only `a-exp.md`.
- `./a-exp kanban --quick a-exp --dry-run --max-cost-items 1 --max-result-bullets 1`: passed, printed only `a-exp.md`.

Files:
- `.agents/skills/kanban/SKILL.md`
- `.agents/skills/kanban/scripts/generate_kanban.py`
- `README.md`
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-13 (Made project input interactive by default)

Changed `a-exp project` so the description file argument is optional. When no
file is provided, the CLI writes a temporary Markdown template, opens it with
VS Code using `code --reuse-window --wait`, and runs the project skill after the
editor closes. The previous `a-exp project <description-file>` flow remains
supported for scripted use, and `--editor <cmd>` can override the editor command.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 20 tests.
- `./a-exp project projects/a-exp/TASKS.md --dry-run`: passed, printed the generated project-skill prompt.
- `./a-exp project --editor true --dry-run`: passed, created a temp project description file and exited without running because it was unchanged.

Files:
- `README.md`
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-13 (Daemonized scheduler start by default)

Changed `a-exp start` to launch the scheduler as a detached background daemon while preserving the previous foreground behavior behind `a-exp start --foreground`. The daemon path spawns the same CLI in foreground mode with `--repo <workspace>`, writes runtime output to `.a-exp/logs/daemon.log`, waits briefly for the scheduler PID lock, and leaves `status` and `stop` on the existing lockfile interaction model. Also fixed `stop` stale-lock cleanup so dead PID lockfiles are actually removed.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 19 tests.
- `./a-exp start`: passed with elevated permission for the daemon socket bind, reported a daemon PID and `.a-exp/logs/daemon.log`.
- `./a-exp status`: passed, reported `Daemon: running` after start and `Daemon: stopped` after stop.
- `./a-exp stop`: passed with elevated permission, sent `SIGTERM` to the daemon PID.

Files:
- `README.md`
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-13 (Added kanban and packet skill CLI wrappers)

Added `a-exp kanban [project]` and `a-exp packet <project> <target-package> [instructions...]` as thin wrappers around the `kanban` and `packet` skills. Both commands share the manual skill-job execution path used by `a-exp project`, support `--model`, `--max-duration-ms`, and `--dry-run`, and expose skill-specific prompt options for kanban output limits and packet handoff arguments.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 17 tests.
- `./a-exp kanban a-exp --output-dir reports/kanban --max-cost-items 2 --max-result-bullets 3 --dry-run`: passed, printed the generated kanban-skill prompt.
- `./a-exp packet a-exp /tmp/target-package prefer CLI integration notes --dry-run`: passed, printed the generated packet-skill prompt.

Files:
- `AGENTS.md`
- `README.md`
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-13 (Added project skill CLI wrapper)

Added `a-exp project <description-file>` as a thin wrapper around the `project` skill. The command parses `Title:`, `Mode:`, and `Project:` headers, defaults to scaffold mode, supports `--mode`, `--model`, `--max-duration-ms`, and `--dry-run`, and launches a manual project-skill agent job when not in dry-run mode. Added parser and prompt-builder tests.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 15 tests.
- `./a-exp project projects/a-exp/TASKS.md --dry-run`: passed, printed the generated scaffold-mode project-skill prompt.

Files:
- `infra/scheduler/src/cli.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-04 (Added packet summaries to kanban output)

Augmented the kanban skill and generator so matching packet Markdown under `reports/packet/`, `reports/packets/`, or promo packet directories adds an optional `## <project>-Packets` section with one compact packet card per file. Packet directories are now excluded from generic report summaries to avoid duplicate report cards.

Verification:
- `python -c "import ast, pathlib; ast.parse(pathlib.Path('.agents/skills/kanban/scripts/generate_kanban.py').read_text())"`: passed.
- `python -c "import argparse, importlib.util, pathlib, sys, tempfile; sys.dont_write_bytecode=True; p=pathlib.Path('.agents/skills/kanban/scripts/generate_kanban.py'); spec=importlib.util.spec_from_file_location('gk', p); m=importlib.util.module_from_spec(spec); sys.modules['gk']=m; spec.loader.exec_module(m); root=pathlib.Path(tempfile.mkdtemp(dir='/private/tmp')); project=root/'projects'/'demo'; packet_dir=root/'reports'/'packet'; project.mkdir(parents=True); packet_dir.mkdir(parents=True); (project/'TASKS.md').write_text('- [x] Build packet support\n', encoding='utf-8'); (packet_dir/'demo-to-target-solver.md').write_text('# Algorithm Implementation Packet: Solver\n\n## 1. Purpose\n\nPort demo solver into target.\n\n## 4. Verified Behavior\n\n- RMSE 0.12 on fixture\n\n## 8. Test Plan\n\n- Add regression test\n', encoding='utf-8'); out=m.generate_project(root, project, argparse.Namespace(max_cost_items=2, max_result_bullets=3)); print(out)"`: printed a `## demo-Packets` section and did not duplicate the packet as a report.
- `python .agents/skills/kanban/scripts/generate_kanban.py --repo-root . --dry-run --max-cost-items 1 --max-result-bullets 2`: passed; current repo output has no packet section because no matching packets exist.

Files:
- `.agents/skills/kanban/SKILL.md`
- `.agents/skills/kanban/scripts/generate_kanban.py`
- `projects/a-exp/README.md`

### 2026-05-03 (Fixed Codex startup failure classification)

Fixed scheduler Codex failure handling so `type: "error"` and `turn.failed` JSONL events mark the backend result as failed, non-zero Codex process exits reject even when stderr has text, and backend `ok: false` propagates through agent and job execution status. Added regressions for ignored JSON error events, stderr-bearing non-zero exits, and scheduled jobs that receive Codex JSON error events.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 13 tests.

Files:
- `infra/scheduler/src/backend.ts`
- `infra/scheduler/src/agent.ts`
- `infra/scheduler/src/executor.ts`
- `infra/scheduler/src/core.test.ts`
- `projects/a-exp/README.md`

### 2026-05-02 (Switched task policy to mid-sized units)

Updated the core task policy, scaffold guidance, orient task-supply rules, and examples to prefer mid-sized coherent tasks with optional multi-bullet `Done when` criteria. Task granularity now honors user requests for finer or coarser decomposition when each task remains bounded and verifiable. Added a report parser regression test and a kanban parser note so acceptance checklists are not counted as separate tasks.

Verification:
- `cd infra/scheduler && npm run build`: passed.
- `cd infra/scheduler && npm test`: passed, 2 files and 10 tests.
- `python -c "import importlib.util, sys, tempfile, pathlib; p=pathlib.Path('.agents/skills/kanban/scripts/generate_kanban.py'); spec=importlib.util.spec_from_file_location('gk', p); m=importlib.util.module_from_spec(spec); sys.modules['gk']=m; spec.loader.exec_module(m); d=pathlib.Path(tempfile.mkdtemp()); f=d/'TASKS.md'; f.write_text('# Tasks\n\n- [ ] Ship mid-sized task\n  Why: test\n  Done when:\n  - [ ] Build passes\n  - [ ] Report shows one task\n  Priority: high\n', encoding='utf-8'); tasks=m.parse_tasks(f); print(len(tasks), tasks[0].title if tasks else '')"`: printed `1 Ship mid-sized task`.
- `rg -n 'small tasks|decomposed next actions|decomposed tasks|decomposed task|3-5 bootstrapping|>2 independent|>3 files|mixed mechanical|multiple fleet-eligible|single complex|smallest change|task decomposition' AGENTS.md README.md docs .agents infra/scheduler/src examples projects/a-exp -S`: no matches.

Files:
- `AGENTS.md`
- `docs/conventions/task-lifecycle.md`
- `docs/schemas/task.md`
- `.agents/skills/`
- `infra/scheduler/src/workspace.ts`
- `infra/scheduler/src/core.test.ts`
- `examples/my-research-project/TASKS.md`

### 2026-04-30 (Added packet handoff skill)

Added the `packet` skill for producing implementation-ready algorithm packets from a-exp prototypes, target package instructions, prototype code, experiments, reports, and project memory. The skill writes packets under `reports/packet/` by default and uses the target package's API conventions rather than prototype code style as the integration source of truth.

Verification:
- `python /Users/daninghuang/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/packet`: passed, skill is valid.

Files:
- `.agents/skills/packet/SKILL.md`
- `.agents/skills/packet/agents/openai.yaml`
- `projects/a-exp/README.md`

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
