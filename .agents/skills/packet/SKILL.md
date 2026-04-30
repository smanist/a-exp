---
name: packet
description: Create an algorithm implementation packet from an a-exp project prototype for implementation in another package. Use when the user invokes packet with a project name, target package path, and optional additional instructions, or asks Codex to summarize prototype code, raw results, reports, and project memory into a handoff document that another agent can implement against a target package's APIs and AGENTS.md instructions.
---

# Packet

Create a concise, implementation-ready handoff packet for porting an a-exp prototype into another package.

## Invocation

Expected user shape:

```text
packet <project-in-this-repo> <path-to-target-package> <additional instructions>
```

Interpret arguments as:

- `<project-in-this-repo>`: project name under `projects/<project>` and usually `modules/<project>`.
- `<path-to-target-package>`: package where another agent will implement the algorithm or feature.
- `<additional instructions>`: user constraints, target module hints, test expectations, API preferences, or scope limits.

If an argument is missing and cannot be inferred safely, ask one concise question. Otherwise proceed.

## Workflow

1. Read target package instructions first:
   - `<target>/AGENTS.md`, `<target>/agents.md`, or nearest parent equivalent.
   - Package README, pyproject/package metadata, source layout, and existing APIs relevant to the requested implementation.
   - Existing tests for the target subsystem, especially style for numerical tolerances, fixtures, and return objects.

2. Read a-exp project context:
   - `projects/<project>/README.md`
   - `projects/<project>/TASKS.md`
   - `projects/<project>/experiments/**/EXPERIMENT.md`
   - `projects/<project>/plans/**`
   - `projects/<project>/reports/**` and repo-level `reports/**` when relevant.
   - `modules/<project>/**`, prioritizing prototype source, scripts, configs, notebooks, and artifact manifests over heavy raw outputs.

3. Identify the prototype's actual contract:
   - Problem solved and mathematical objects.
   - Inputs, outputs, dimensions, assumptions, and invariants.
   - Objective or update equations.
   - Numerical method, stopping criteria, regularization, tolerances, and fallback behavior.
   - Reproducible commands and artifact locations.
   - Verified results, metrics, known failures, and unresolved questions.

4. Map prototype behavior to the target package:
   - Conform to the target package's public API, naming, typing, dependency, and error-handling style.
   - Do not recommend copying prototype style when it conflicts with target package conventions.
   - Prefer narrow integration points that fit existing modules.
   - Distinguish required behavior from prototype incidental details.
   - Use prototype results as regression fixtures, correctness oracles, and test data where practical.

5. Write the packet under `reports/packet/` in the current repo unless the user requests another location. Use a filename like:

```text
reports/packet/<project>-to-<target-package>-<topic>.md
```

Create `reports/packet/` if needed. Keep heavyweight generated data out of the packet; link to source artifacts instead.

## Packet Template

Use this structure and omit only sections that are genuinely inapplicable:

```markdown
# Algorithm Implementation Packet: <Algorithm Name>

## 1. Purpose

What problem this algorithm solves and why it belongs in the target package.

## 2. Mathematical Formulation

Definitions, inputs, outputs, objective, assumptions, dimensions, constraints, and update equations.

## 3. Prototype Location

Files, scripts, notebooks, commands to reproduce, and relevant artifact paths.

## 4. Verified Behavior

Tests, experiments, commands, metrics passed, numerical tolerances, representative outputs, and observed failure cases.

## 5. Required Package Integration

Target-package-specific guidance:

- Recommended module path
- Public API signatures
- Config fields
- Return objects
- Error handling
- Logging/progress behavior
- Serialization or artifact behavior

## 6. Dependencies

Required and optional packages, versions if known, numerical constraints, hardware assumptions, and dependency risks.

## 7. Edge Cases

Small data, shape mismatches, ill-conditioning, missing values, boundary conditions, singular matrices, stiff regimes, convergence failures, and precision issues.

## 8. Test Plan

Unit tests, regression tests from prototype artifacts, integration tests, benchmark tests, fixtures, and acceptance criteria.

## 9. Example Usage

Minimal target-package-level example that follows the target package's conventions.

## 10. Implementation Risks

Known approximations, numerical sensitivities, assumptions that may not hold generally, missing validations, and open design decisions.
```

## Quality Bar

- Cite exact source files and commands with paths.
- Separate facts verified from source artifacts from implementation recommendations.
- Include enough mathematical detail that another agent can implement without re-reading the whole prototype.
- Include enough target package detail that another agent can implement without inventing an API.
- Prefer concrete shapes, tolerances, and expected values over vague descriptions.
- Preserve open questions; do not resolve uncertain behavior by guessing.
