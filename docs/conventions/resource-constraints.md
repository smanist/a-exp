# Resource Constraints

Budget support is informational in the trimmed core.

- `budget.yaml` declares resource limits.
- `ledger.yaml` records declared usage.
- Reports summarize the repo files.
- External provider auditing is intentionally not included.

Long-running or costly experiments should run through `infra/experiment-runner` with `--artifacts-dir`, `--project-dir`, and explicit `--max-retries`.
