# Experiment Runner

Launch long-running experiment commands outside the agent session, write progress state, and place outputs under a module artifact directory.

## Usage

```bash
python infra/experiment-runner/run.py \
  --detach \
  --artifacts-dir modules/<module>/artifacts/<experiment-id> \
  --project-dir projects/<project> \
  --max-retries 0 \
  --watch-csv modules/<module>/artifacts/<experiment-id>/results.csv \
  --total 100 \
  projects/<project>/experiments/<experiment-id> \
  -- <command...>
```

The experiment directory should contain `EXPERIMENT.md`. The runner writes `progress.json` and logs so later sessions can inspect completion without polling inside an agent session.

## Required Flags For Resource-Consuming Runs

- `--artifacts-dir`: destination for logs and heavy outputs.
- `--project-dir`: project directory containing optional `budget.yaml` and `ledger.yaml`.
- `--max-retries`: explicit retry policy.
- `--watch-csv` and `--total`: progress guard for tabular outputs.

Budget handling is lightweight. The runner can read repo budget files for preflight context, but the trimmed core does not audit external providers.
