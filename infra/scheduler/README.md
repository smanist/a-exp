# a-exp Scheduler

Minimal cron scheduler for recurring agent sessions, Slack notifications, status, and reports.

## Commands

```bash
./a-exp init --project my-research-project
./a-exp start
./a-exp stop
./a-exp add --name work-cycle --cron "0 * * * *" --message-default --model gpt-5.2
./a-exp list
./a-exp run <job-id>
./a-exp enable <job-id>
./a-exp disable <job-id>
./a-exp status
./a-exp heartbeat
./a-exp check-health --notify
```

All commands target the initialized workspace discovered from the current
directory by `.a-exp/config.yaml`. Use `--repo <dir>` to target another project
repo explicitly:

```bash
./a-exp --repo /path/to/project-repo status
```

## Build

```bash
cd infra/scheduler
npm install
npm run build
```

## Slack

The active scheduler Slack path is DM-only and optional.

Required environment variables:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_USER_ID`

Optional:

- `SLACK_CHAT_MODEL`

When Slack is not configured, Slack calls degrade to no-ops.

The fuller Slack reference lives in `reference-implementations/slack/` and compiles with:

```bash
npm run test:slack-reference
```

## Status API

`start` launches a local status API:

- `GET /api/status`

The `check-health` command pings this endpoint. The trimmed core intentionally does not expose push queues, fleet endpoints, or task-claim APIs.

## Reports

Reports are generated from repo files and scheduler metrics:

```bash
cd infra/scheduler
npx tsx src/report/run-report.ts --repo ../.. --type project --project a-exp
```

Budget report data is lightweight: it reads `projects/*/budget.yaml` and `ledger.yaml` only.
