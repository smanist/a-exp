# akari - Next actions

- [ ] Finish scheduler surface reduction
  Why: The repo trim removes obsolete docs/projects first, but scheduler internals still need final pruning to match the retained public commands and Slack/report paths.
  Done when: `cd infra/scheduler && npm run build` passes and stale references to deleted worker-pool, burst, and budget-audit surfaces are removed or documented as intentional compatibility shims.
  Priority: high

- [ ] Verify retained experiment tooling
  Why: `infra/experiment-runner` and `infra/experiment-validator` are part of the retained core.
  Done when: `python -m pytest infra/experiment-runner infra/experiment-validator` passes.
  Priority: high

- [ ] Add a minimal sample experiment record to the example project
  Why: The project scaffold should demonstrate where experiment records live without carrying old research artifacts.
  Done when: `examples/my-research-project/experiments/example-v1/EXPERIMENT.md` exists and passes the validator.
  Priority: medium
