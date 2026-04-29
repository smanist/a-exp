---
name: review
description: "Validate experiment metrics and findings — run metrics-first to check computations are meaningful, then findings to check conclusions are valid"
complexity: high
model-minimum: strong
disable-model-invocation: false
allowed-tools: ["Read", "Grep", "Glob"]
argument-hint: "[metrics | findings] <path or experiment name>"
---

# /review [metrics | findings] <path or experiment name>

Validate experiment outputs in two modes. **Metrics mode** checks whether metric computations are meaningful given the experimental setup (run *before* writing findings). **Findings mode** checks whether written conclusions are valid (run *after* writing findings). If no mode is specified, run both in sequence: metrics first, then findings.

## When to use this vs alternatives

- **Use `/review metrics`** when you have metric definitions or computed values and want to check whether they are meaningful given the experimental setup.
- **Use `/review findings`** when findings have been written and you want to validate each claim.
- **Use `/review`** (no mode) to run the full pipeline: metrics validation → findings validation.
- **Use `/critique`** for a broad adversarial review across 9 failure dimensions. Critique is wider but shallower; /review goes deeper on metric validity and finding correctness.
- **Use `/diagnose`** when you want to understand *what results mean* — error patterns, root causes, hypotheses. Diagnose interprets results; /review checks whether they are interpretable and correctly stated.

---

## Metrics mode

### 1. Extract the constraint set

Identify the fixed parameters of the experiment:
- **Response schema**: What values can the model output? (e.g., `Literal["A", "B"]`, 1-5 scale, free text)
- **n_runs**: How many repeated calls per evaluation?
- **Temperature**: Is there randomness across runs?
- **Sample size**: How many items/pairs/tasks?
- **Ground truth structure**: Does ground truth include ties, ordinal rankings, continuous scores?
- **Aggregation method**: How are repeated runs combined? (majority vote, mean, threshold)

### 2. For each metric, apply these tests

#### Degeneracy test
Given the constraints, can this metric take more than one value? If the setup forces the metric to a constant regardless of model behavior, it is **degenerate**.

Examples: accuracy with n_runs=1 → always (non-tie GTs / total); confidence range with binary schema → always 0% or 100%; inter-run agreement with temperature=0 → always ~100%.

#### Discriminative power test
Can this metric distinguish between the things we want to compare? If all conditions produce the same value, it does not discriminate. Check variance across conditions and whether a random baseline scores similarly.

#### Denominator test
Is the metric computed over a meaningful base? Is the denominator large enough? Are subgroups large enough when sliced?

#### Interpretation test
Does the metric name match what it actually measures? Check the computation — "accuracy" might mean tie-detection accuracy, not winner-correctness.

#### Cross-experiment comparison test
For any metric comparison across experiments or projects, verify that denominators and filtering criteria are explicitly stated. Example: "X% correctness on non-tie predictions (N=550)" vs "Y% correctness including ties (N=1595)". Flag comparisons that could mislead if denominators differ silently.

### 3. Trace to source

For each metric, find where it is computed in the codebase. Verify the implementation matches the claimed definition.

### Metrics output format

```
## Metric Audit: <experiment>

### Constraints
- Response schema: ...
- n_runs: ...
- Temperature: ...
- Sample size: ...
- Ground truth: ...

### <Metric name>
- Computation: <how it's calculated, with file:line reference>
- Degenerate: yes | no
- Discriminative: yes | no
- Denominator: adequate | too small | missing
- Name matches meaning: yes | no
- Cross-experiment comparison: n/a | explicit denominator (N=...) | implicit/ambiguous
- Verdict: **valid** | **degenerate** | **misleading** | **underpowered**
- Action: keep | remove | rename | recompute with <change>

### Summary
- Metrics audited: N
- Valid: N | Degenerate: N | Misleading: N | Underpowered: N
```

---

## Findings mode

### For each finding or conclusion, apply these tests

#### 1. Design-vs-discovery test
Ask: "Could this result have been different given the experimental setup?" If no — if the result is a necessary consequence of the protocol — it is a **design constraint**, not a finding.

Tautologies to catch: "All outputs are binary" when schema is `Literal["A", "B"]`; "No ties detected" when n_runs=1; "100% recall" when the pipeline never predicts the negative class.

#### 2. Layer attribution test
Which CI layer does the finding describe (L1-L5)? Is that attribution correct? Flag when a finding attributes to L1 (Model) what is actually caused by L2 (Workflow) or L4 (Evaluation).

#### 3. Falsifiability test
Could an experiment in principle refute this claim? If not, reframe as a limitation or design note.

#### 4. Redundancy test
Does another finding in the same report already cover this with better framing? Merge or cut the weaker version.

#### 5. Missing denominator test
Are rates reported without their base? Are counts presented without context for whether they're large or small?

#### 6. Anthropomorphic explanation test
Does the finding explain model behavior using human psychological states (pressure, confusion, fatigue)? LLMs do not experience these. Use mechanistic terms: ungrounded generation, context window limits, training distribution mismatch, missing verification gate.

#### 7. Cross-session citation verification test
For each numerical finding cited from a prior experiment, verify the number by re-running the source script or comparing against the source data file. Do not copy numbers from text. Agents frequently copy numerical findings without verification, allowing stale or contaminated numbers to propagate undetected across sessions.

#### 8. Narrative coherence test
Does every category, dimension, or capability claimed in narrative sections have corresponding statistical validation? Extract all named categories from introduction, method, and discussion sections (e.g., "we present 7 skills", "evaluating across 5 dimensions", "three failure modes"). For each, check that results sections provide quantitative evidence for that specific category. Flag gaps: "claims N categories but validates M" where M < N. This catches the common failure mode where narrative ambition exceeds validation scope.

### Findings output format

```
## Finding Review: <artifact>

### <Finding N>: "<quoted claim>"
- Design-or-discovery: design constraint | genuine finding | mixed
- Layer attribution: <claimed> → <actual> (or "correct")
- Falsifiable: yes | no
- Redundant with: <other finding> | none
- Missing denominator: yes | no
- Anthropomorphic explanation: yes | no
- Citation verified: n/a | yes (source: <file or command>) | no (stale/unverifiable)
- Narrative coherence: all categories validated | gaps: <missing categories> | n/a
- Verdict: **keep** | **reframe** | **cut**
- Note: <explanation if reframe or cut>

### Summary
- Findings reviewed: N
- Keep: N | Reframe: N (list) | Cut: N (list)
```

---

## Common rationalizations

| Excuse | Reality |
|--------|---------|
| "This finding is obviously valid" | Obvious findings are the ones most likely to be tautologies. Apply all tests. |
| "The design-vs-discovery test doesn't apply" | It applies to every finding. If you can't say why the result could have been different, it's a design constraint. |
| "Saying the model was confused is shorthand" | Shorthand that forecloses investigation. Use mechanistic terms. |
| "Checking all tests is excessive" | It takes 30 seconds per finding. Skipping is how tautologies enter the record. |
| "The number was already verified in the source experiment" | The source experiment may have been modified, or the number may have been miscopied. Re-verify. |

## Red flags — STOP

- Marking "keep" without checking all tests
- Using "confused", "struggled", or "tried" to describe model behavior
- A finding that restates experimental design as a result
- Reporting a metric without its denominator
- Comparing metrics across experiments without stating denominators/filtering criteria
- Accepting a finding because it confirms expectations
- Citing a numerical finding from another experiment without verifying against source data
- Claiming N categories/dimensions in narrative but validating fewer than N

## Commit

Follow `docs/sops/commit-workflow.md`. Commit message: `review: <artifact reviewed>`
