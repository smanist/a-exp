Standard procedure for committing work in the akari repo.

## Commit Workflow

When: Any work unit is complete (feature implementation, bugfix, experiment setup, documentation update).
Requires: Git repo in clean state or with staged/unstaged changes ready to commit.

### 1. Stage changes

- Review `git status` to identify all modified and untracked files
- Stage relevant files: `git add <files>` or `git add .` for all changes
- **Do not stage files that should not be committed**: `.env`, credentials, secrets, large binary artifacts

→ Output: All relevant changes staged

### 2. Verify before commit

- Run `python infra/experiment-validator/validate.py` — must pass (catches EXPERIMENT.md schema errors, lint issues)
- Run `npm test` in `infra/scheduler/` if any TypeScript files changed — must pass
- If adding/modifying tests, run them explicitly to confirm they pass

→ Output: All validation checks pass

### 3. Write commit message

- Use imperative mood: "add feature" not "added feature"
- Start with a tag: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
- Keep first line under 72 characters
- If commit closes an issue, reference it: "fix: resolve timeout issue (closes #123)"

→ Output: Descriptive commit message ready

### 4. Commit

```
git commit -m "type: description"
```

→ Output: Changes committed with descriptive message

### 5. Push (automatic for autonomous sessions)

- Autonomous sessions: the scheduler's executor handles `git pull --rebase origin main` and push after the session completes. If rebase fails, it pushes to a `session-{runId}` fallback branch. Agents do not need to push manually.
- Manual sessions: `git push` to publish changes

→ Output: Changes synchronized with remote

Check: `git status` shows "nothing to commit, working tree clean" (or only intentionally uncommitted files like `.env`).

## Task Completion: Combine Ceremony

When completing a task, combine all task-closing changes into a single commit with the work:

- Task marking: updating `[ ]` → `[x]` in TASKS.md with `Completed:` line
- Log entry: adding dated summary to project README
- Work changes: code, docs, config changes from the task itself

**Correct pattern (single commit):**
```
git add src/feature.ts projects/myproject/TASKS.md projects/myproject/README.md
git commit -m "feat: add feature X

- Implement X logic
- Mark task complete in TASKS.md
- Add log entry to README"
```

**Anti-pattern (multiple commits):**
```
git add src/feature.ts
git commit -m "feat: add feature X"
git add projects/myproject/TASKS.md
git commit -m "chore: mark task complete"
git add projects/myproject/README.md
git commit -m "docs: add log entry"
```

Rationale: Separate ceremony commits clutter history and waste fleet capacity. A task completion is one logical unit of work.
