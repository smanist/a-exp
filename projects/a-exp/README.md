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
