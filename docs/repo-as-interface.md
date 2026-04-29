# Repo As Interface

OpenAkari does not hide its operating model behind a large service API. The files are the interface.

An agent should be able to:

1. Read `AGENTS.md`.
2. Read a project's `README.md` and `TASKS.md`.
3. Select or create a decomposed task.
4. Update project memory as it works.
5. Use `./akari` for scheduled sessions and status.
6. Use experiment tooling for long-running work.

## Why Files

Files make the system:

- inspectable by humans
- diffable in git
- easy for agents to search
- resilient across stateless sessions

## What Success Looks Like

The repo succeeds when a fresh session can continue useful work by reading only committed files. If a finding, task, budget record, or artifact path is not in the repo, future agents should treat it as unknown.
