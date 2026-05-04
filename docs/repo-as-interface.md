# Repo As Interface

a-exp does not hide its operating model behind a large service API. The files in
an initialized project repo are the interface.

Run `a-exp init --project <name>` in a repo parallel to `a-exp/` to create the
workspace anchor `.a-exp/config.yaml`, symlink `.agents` and `docs` from
`../a-exp`, and create the standard `projects/<name>/` and `modules/<name>/`
layout. Subsequent commands discover that repo from the current directory, or
use `--repo <dir>` when a script should target a specific workspace.

An agent should be able to:

1. Read `AGENTS.md`.
2. Read a project's `README.md` and `TASKS.md`.
3. Select or create a bounded task.
4. Update project memory as it works.
5. Use `a-exp` for scheduled sessions and status.
6. Use experiment tooling for long-running work.

## Why Files

Files make the system:

- inspectable by humans
- diffable in git
- easy for agents to search
- resilient across stateless sessions

## What Success Looks Like

The repo succeeds when a fresh session can continue useful work by reading only
committed files. If a finding, task, budget record, or artifact path is not in
the repo, future agents should treat it as unknown. Runtime files under
`.a-exp/` are operational state; `.a-exp/config.yaml` and
`.a-exp/kit.lock.yaml` are durable workspace identity.
