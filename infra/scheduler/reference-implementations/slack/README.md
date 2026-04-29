# Full Slack Reference

This folder keeps the fuller Slack interface as a runnable reference for teams that want more than the active DM-only scheduler integration.

It includes:

- multi-channel Slack wiring
- living message helpers
- file upload helpers
- an example Slack app manifest
- compatibility shims that point at the trimmed scheduler core

The reference compiles with:

```bash
cd infra/scheduler
npm run test:slack-reference
```

Workspace-specific tokens, app review, and product policy are still deployment responsibilities. Fleet execution is not part of OpenAkari Core; fleet-related Slack status functions degrade to explanatory placeholders.
