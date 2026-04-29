# Budget And Ledger Schema

`budget.yaml`:

```yaml
resources:
  llm_api_calls:
    limit: 5000
    unit: calls
deadline: 2026-06-01T00:00:00Z
```

`ledger.yaml`:

```yaml
entries:
  - date: 2026-04-29
    resource: llm_api_calls
    amount: 100
    note: initial experiment
```

Reports read these files only. They do not audit external providers.
