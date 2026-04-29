# Dedup Consistency Audit

**Date**: 2026-03-06
**Session**: fleet-worker-mmeogcuyb131
**Task**: Audit experiment-runner dedup consistency across functions

## Summary

Audit of three deduplication functions in `infra/experiment-runner/run.py`:

| Function | Line | Method | Usage |
|----------|------|--------|-------|
| `read_unique_csv_rows` | 464 | Whole-row dedup | `--watch-csv` progress tracking |
| `_count_unique_csv_rows` | 801 | Key-column dedup (pandas) | Consumption audit |
| `_count_unique_csv_rows_simple` | 822 | Whole-line dedup | Fallback when pandas fails |

## Key Findings

### Finding 1: Inconsistency on CSVs with partial key columns

**Test case**: CSV with `run_id,task_id,model` columns (only `task_id` is a key column)

```
CSV content:
run_id,task_id,model
1,t1,m1
1,t1,m2
2,t1,m1

Results:
read_unique_csv_rows:      3 (whole-row dedup)
_count_unique_csv_rows:    1 (dedupes on task_id alone!)
_count_unique_csv_rows_simple: 3 (whole-line dedup)
```

**Impact**: Consumption audit would report 1 unique row instead of 3, significantly undercounting progress.

**Root cause**: `_count_unique_csv_rows` checks for ANY of the 6 key columns and dedupes on those present. If only `task_id` exists, it dedupes on `task_id` alone, which is insufficient.

### Finding 2: Inconsistency on CSVs with full key columns + extra columns

**Test case**: CSV with all 6 key columns plus a `score` column

```
CSV content:
dataset,task_id,model_a,model_b,render_type,question_key,score
d1,t1,m1,m2,std,q1,0.8
d1,t1,m1,m2,std,q1,0.9  <- same keys, different score
d1,t1,m1,m2,std,q2,0.7

Results:
read_unique_csv_rows:      3 (whole-row dedup)
_count_unique_csv_rows:    2 (dedupes on key columns, ignores score)
_count_unique_csv_rows_simple: 3 (whole-line dedup)
```

**Impact**: Consumption audit would report 2 unique rows instead of 3 when rows have same keys but different non-key values.

**Root cause**: Key-column dedup intentionally ignores non-key columns. This is correct for pairwise-comparison-style evaluations where (dataset, task_id, model_a, model_b, render_type, question_key) defines a unique judgment, but incorrect for other CSV schemas.

### Finding 3: Consistency on CSVs without key columns

**Test case**: CSV with `task_id,value` columns (no key columns match)

```
CSV content:
task_id,value
001,a
002,b
001,a

Results:
read_unique_csv_rows:      2
_count_unique_csv_rows:    2 (falls back to _count_unique_csv_rows_simple)
_count_unique_csv_rows_simple: 2
```

**Impact**: No inconsistency - all functions agree.

**Note**: `_count_unique_csv_rows` falls back to `_count_unique_csv_rows_simple` when pandas raises an exception (e.g., key columns not found).

## Recommendations

### Option A: Unify on whole-row dedup (recommended)

Change `_count_unique_csv_rows` to use whole-row dedup instead of key-column dedup.

**Pros**:
- Consistent behavior across all functions
- Simpler logic, no special cases
- Matches user expectation of "unique rows"

**Cons**:
- For pairwise-comparison-style CSVs with re-evaluations of same (dataset, task_id, model_a, model_b, render_type, question_key), would count duplicate attempts as unique rows

**Implementation**: Replace `_count_unique_csv_rows` with `_count_unique_csv_rows_simple` in consumption audit call (line 333 in run.py).

### Option B: Add schema-aware dedup

Keep key-column dedup for known schemas (pairwise-comparison-style) and whole-row dedup for others.

**Pros**:
- Preserves domain-specific behavior
- More precise counting for known schemas

**Cons**:
- More complex, harder to maintain
- Requires schema detection logic
- Risk of future inconsistencies

### Option C: Document and accept inconsistency

Accept that progress tracking and consumption audit may differ, and document when each should be used.

**Pros**:
- No code changes
- Preserves existing behavior

**Cons**:
- Confusing for users
- Risk of misinterpreting progress counts

## Test File

Test file: `infra/experiment-runner/test_dedup_consistency.py`

Run with:
```bash
cd infra/experiment-runner && python3 -m pytest test_dedup_consistency.py -v
```

## Related

- Fix that triggered this audit: `read_unique_csv_rows` was changed from first-column dedup to whole-row dedup (session mmenyxwt, 2026-03-06)
- Key-column dedup logic: lines 801-819 in `run.py`
- Key columns: `dataset`, `task_id`, `model_a`, `model_b`, `render_type`, `question_key`
