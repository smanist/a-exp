#!/usr/bin/env python3
"""Launch an experiment command as a background process with progress tracking.

Writes progress.json to the experiment directory, captures stdout/stderr to a
log file, and optionally monitors an output CSV for row-count progress.

Usage:
    python run.py <experiment_dir> <command...>
    python run.py --watch-csv results/output.csv --total 165 <experiment_dir> <command...>
    python run.py --detach <experiment_dir> <command...>

The experiment directory must exist and should follow the akari experiment
convention (contain EXPERIMENT.md). progress.json is written alongside it.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


PROGRESS_FILE = "progress.json"
LOG_FILE = "output.log"
LOCK_FILE = ".experiment.lock"

# Budget pre-check support — reads budget.yaml/ledger.yaml without importing yaml.
# Uses line-based parsing to avoid adding pyyaml as a dependency.

# Signal-based exit codes that indicate transient (retriable) failures.
# 128 + signal_number: SIGFPE=8, SIGKILL=9, SIGSEGV=11, SIGABRT=6
TRANSIENT_EXIT_CODES = {134, 136, 137, 139}  # SIGABRT, SIGFPE, SIGKILL, SIGSEGV


def is_transient_failure(exit_code: int) -> bool:
    """Classify whether an exit code indicates a transient (retriable) failure."""
    return exit_code in TRANSIENT_EXIT_CODES


def resolve_command(command: list[str]) -> list[str]:
    """Resolve the executable in a command list to its absolute path.

    In detached mode (start_new_session=True), PATH may not include standard
    directories. Resolving 'bash' → '/usr/bin/bash' etc. prevents 'command not
    found' errors. Only resolves bare names (no '/' in the name); paths like
    './run.sh' or '/usr/bin/bash' are left unchanged.
    """
    if not command:
        return command
    exe = command[0]
    if "/" not in exe:
        resolved = shutil.which(exe)
        if resolved:
            return [resolved] + command[1:]
    return list(command)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_progress(experiment_dir: Path, data: dict) -> None:
    """Atomically write progress.json."""
    path = experiment_dir / PROGRESS_FILE
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.rename(path)


def acquire_lock(experiment_dir: Path) -> int | None:
    """Acquire an exclusive file lock for the experiment directory.

    Returns the lock file descriptor on success, or None if already locked.
    Uses fcntl.flock (advisory lock) — the lock is released when the fd is
    closed or the process exits.
    """
    lock_path = experiment_dir / LOCK_FILE
    try:
        fd = os.open(str(lock_path), os.O_WRONLY | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Write PID for diagnostics
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, f"{os.getpid()}\n".encode())
        return fd
    except OSError:
        # Already locked by another process
        return None


def release_lock(fd: int, experiment_dir: Path) -> None:
    """Release the experiment lock."""
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    except OSError:
        pass
    # Clean up lock file
    lock_path = experiment_dir / LOCK_FILE
    try:
        lock_path.unlink(missing_ok=True)
    except OSError:
        pass
def check_budget(project_dir: Path, estimated_calls: int | None) -> tuple[bool, str]:
    """Pre-execution budget check. Returns (ok, message).

    Reads budget.yaml and ledger.yaml from project_dir using line-based
    parsing (no yaml dependency). If estimated_calls is provided, checks
    whether the experiment would exceed remaining budget.
    """
    budget_path = project_dir / "budget.yaml"
    if not budget_path.exists():
        return True, "No budget.yaml found, skipping budget check"

    # Parse budget resources and deadline (line-based)
    resources: dict[str, dict[str, int | str]] = {}
    current_resource: str | None = None
    deadline_str: str | None = None
    try:
        with open(budget_path) as f:
            for line in f:
                stripped = line.rstrip()
                dm = re.match(r'^deadline:\s*(.+)$', stripped)
                if dm:
                    deadline_str = dm.group(1).strip().strip('"\'')
                    continue
                rm = re.match(r'^  (\w[\w_-]*):\s*$', stripped)
                if rm:
                    current_resource = rm.group(1)
                    resources[current_resource] = {"limit": 0, "unit": ""}
                    continue
                if current_resource:
                    lm = re.match(r'^\s+limit:\s*(\d+)', stripped)
                    if lm:
                        resources[current_resource]["limit"] = int(lm.group(1))
                        continue
                    um = re.match(r'^\s+unit:\s*(.+)', stripped)
                    if um:
                        resources[current_resource]["unit"] = um.group(1).strip()
                        continue
    except OSError as e:
        return True, f"Could not read budget.yaml: {e}"

    # Check deadline
    if deadline_str:
        try:
            dl = datetime.fromisoformat(deadline_str.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) > dl:
                return False, f"Project deadline has passed ({deadline_str})"
        except ValueError:
            pass

    # Parse ledger totals (line-based)
    ledger_path = project_dir / "ledger.yaml"
    totals: dict[str, float] = {}
    if ledger_path.exists():
        try:
            current_entry_resource: str | None = None
            with open(ledger_path) as f:
                for line in f:
                    stripped = line.rstrip()
                    rm2 = re.match(r'^\s+resource:\s*(.+)', stripped)
                    if rm2:
                        current_entry_resource = rm2.group(1).strip()
                        continue
                    am = re.match(r'^\s+amount:\s*(\d+(?:\.\d+)?)', stripped)
                    if am and current_entry_resource:
                        totals[current_entry_resource] = totals.get(current_entry_resource, 0) + float(am.group(1))
                        current_entry_resource = None
                        continue
                    if re.match(r'^\s+-\s+date:', stripped):
                        current_entry_resource = None
        except OSError:
            pass

    # Check each resource
    warnings = []
    for rtype, spec in resources.items():
        limit = spec["limit"]
        consumed = totals.get(rtype, 0)
        remaining = limit - consumed
        pct = round(100 * consumed / limit, 1) if limit > 0 else 0

        if consumed >= limit:
            warnings.append(f"Budget exhausted for {rtype}: {int(consumed)}/{limit} {spec['unit']} ({pct}%)")
        elif estimated_calls and rtype == "llm_api_calls" and estimated_calls > remaining:
            warnings.append(
                f"Estimated {estimated_calls} calls exceeds remaining budget: "
                f"{int(remaining)} {spec['unit']} left ({int(consumed)}/{limit}, {pct}%)"
            )

    if warnings:
        return False, "; ".join(warnings)

    # Budget OK — report status
    parts = []
    for rtype, spec in resources.items():
        consumed = totals.get(rtype, 0)
        remaining = spec["limit"] - consumed
        parts.append(f"{rtype}: {int(remaining)}/{spec['limit']} {spec['unit']} remaining")
    return True, "Budget OK: " + ", ".join(parts)


import re
from glob import glob as _glob


# ---------------------------------------------------------------------------
# Post-completion consumption audit
# ---------------------------------------------------------------------------

def _read_n_runs(experiment_dir: Path) -> int:
    """Read n_runs from config files. Checks config.json first, then config_*.json.

    Experiments may use a single config.json or dimension-specific configs
    (e.g., config_overall.json, config_mesh.json). Returns the max n_runs
    found across all config files, defaulting to 1 if none exist or none
    specify n_runs.
    """
    config_path = experiment_dir / "config.json"
    if config_path.exists():
        try:
            with open(config_path) as f:
                config = json.load(f)
            return int(config.get("n_runs", 1))
        except (json.JSONDecodeError, ValueError, TypeError, OSError):
            return 1

    # Fall back to dimension-specific config files (config_*.json)
    max_n_runs = 1
    for cfg in sorted(experiment_dir.glob("config_*.json")):
        try:
            with open(cfg) as f:
                config = json.load(f)
            max_n_runs = max(max_n_runs, int(config.get("n_runs", 1)))
        except (json.JSONDecodeError, ValueError, TypeError, OSError):
            continue
    return max_n_runs


def _count_csv_rows(path: Path) -> int:
    """Count data rows in a CSV (excludes header)."""
    if not path.exists():
        return 0
    try:
        with open(path) as f:
            lines = sum(1 for _ in f)
        return max(0, lines - 1)
    except OSError:
        return 0


def _parse_ledger_totals(ledger_path: Path) -> dict[str, dict[str, float]]:
    """Parse ledger.yaml totals per (experiment, resource) using line-based parsing.

    Returns {experiment_name: {resource: total_amount}}.
    """
    result: dict[str, dict[str, float]] = {}
    if not ledger_path.exists():
        return result
    current_experiment: str | None = None
    current_resource: str | None = None
    try:
        with open(ledger_path) as f:
            for line in f:
                stripped = line.rstrip()
                em = re.match(r'^\s+experiment:\s*(.+)', stripped)
                if em:
                    current_experiment = em.group(1).strip()
                    continue
                rm = re.match(r'^\s+resource:\s*(.+)', stripped)
                if rm:
                    current_resource = rm.group(1).strip()
                    continue
                am = re.match(r'^\s+amount:\s*(\d+(?:\.\d+)?)', stripped)
                if am and current_experiment and current_resource:
                    if current_experiment not in result:
                        result[current_experiment] = {}
                    result[current_experiment][current_resource] = (
                        result[current_experiment].get(current_resource, 0) + float(am.group(1))
                    )
                    continue
                if re.match(r'^\s+-\s+date:', stripped):
                    current_experiment = None
                    current_resource = None
    except OSError:
        pass
    return result


def consumption_audit(
    experiment_dir: Path,
    project_dir: Path,
    artifacts_dir: Path | None = None,
    resource: str = "llm_api_calls",
) -> dict:
    """Post-completion consumption audit for an experiment.

    Scans result CSVs, computes total API calls (rows × n_runs), compares
    against the project ledger. Returns an audit report dict suitable for
    inclusion in progress.json.
    """
    runtime_dir = artifacts_dir or experiment_dir
    results_dir = runtime_dir / "results"
    audit: dict = {
        "resource": resource,
        "experiment": experiment_dir.name,
    }

    if not results_dir.exists():
        audit["status"] = "no_results_dir"
        audit["message"] = "No results/ directory found"
        return audit

    csv_files = sorted(results_dir.glob("*.csv"))
    if not csv_files:
        audit["status"] = "no_csvs"
        audit["message"] = "No CSV files in results/"
        return audit

    n_runs = _read_n_runs(experiment_dir)
    csv_details = []
    total_rows = 0
    total_unique_rows = 0
    for csv_file in csv_files:
        rows = _count_csv_rows(csv_file)
        unique_rows = _count_unique_csv_rows(csv_file)
        total_rows += rows
        total_unique_rows += unique_rows
        csv_details.append({"file": csv_file.name, "rows": rows, "unique_rows": unique_rows})

    csv_derived_calls = total_rows * n_runs
    unique_derived_calls = total_unique_rows * n_runs

    audit["n_runs"] = n_runs
    audit["csv_files"] = csv_details
    audit["total_rows"] = total_rows
    audit["total_unique_rows"] = total_unique_rows
    audit["csv_derived_calls"] = csv_derived_calls
    audit["unique_derived_calls"] = unique_derived_calls

    # Flag duplicate contamination
    if total_rows != total_unique_rows:
        dup_count = total_rows - total_unique_rows
        audit["duplicate_rows"] = dup_count
        audit["duplicate_warning"] = (
            f"CSV contains {dup_count} duplicate rows "
            f"({total_rows} raw - {total_unique_rows} unique). "
            f"Duplicate-inflated call estimate: {csv_derived_calls}, "
            f"unique-only estimate: {unique_derived_calls}."
        )

    ledger_path = project_dir / "ledger.yaml"
    ledger_totals = _parse_ledger_totals(ledger_path)
    exp_ledger = ledger_totals.get(experiment_dir.name, {})
    ledger_amount = int(exp_ledger.get(resource, 0))
    audit["ledger_recorded"] = ledger_amount

    if ledger_amount == 0:
        audit["status"] = "missing_ledger"
        audit["message"] = (
            f"No ledger entry for {experiment_dir.name}: "
            f"CSV-derived consumption is {csv_derived_calls} {resource} "
            f"({total_rows} rows × {n_runs} n_runs). "
            f"Add a matching entry to {ledger_path} if this consumption should be reported."
        )
    elif csv_derived_calls != ledger_amount:
        diff = csv_derived_calls - ledger_amount
        direction = "UNDER-recorded" if diff > 0 else "OVER-recorded"
        audit["status"] = "discrepancy"
        audit["difference"] = diff
        audit["message"] = (
            f"Ledger {direction} by {abs(diff)} {resource}: "
            f"CSV-derived={csv_derived_calls}, ledger={ledger_amount}."
        )
    else:
        audit["status"] = "ok"
        audit["message"] = (
            f"Ledger matches CSV-derived consumption: "
            f"{csv_derived_calls} {resource}"
        )

    return audit


# Patterns for progress extraction from log output
# tqdm: "  5%|█         | 5/100 [00:10<01:30,  1.05it/s]"  or  "Evaluating:  72%|███| 56/78"
TQDM_RE = re.compile(r"(\d+)%\|.*?\|\s*(\d+)/(\d+)")
# Simpler "N/M" patterns: "56/78 rows", "Processing 56/78"
FRACTION_RE = re.compile(r"(\d+)/(\d+)(?:\s+(?:rows|items|evals|steps|batches|samples|prompts))?")
# Lines starting with these keywords report negative/error counts, not progress.
# e.g. "Failed: 0/156" should not be treated as progress when "Succeeded: 156/156" exists.
NEGATIVE_LINE_RE = re.compile(r"^\s*(failed|error|skipped|dropped|rejected)\b", re.IGNORECASE)


def parse_log_progress(log_path: Path) -> dict | None:
    """Extract progress from the last few lines of the log file.

    Looks for tqdm-style bars or N/M fraction patterns.
    Returns {"current": int, "total": int, "pct": float, "message": str} or None.

    When multiple fraction matches exist, prefers lines that are not negative
    indicators (e.g. "Failed: 0/156") and picks the match with the highest
    current value, since that best represents actual progress.
    """
    try:
        with open(log_path, "rb") as f:
            # Read last 2KB — enough for a few log lines
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 2048))
            tail = f.read().decode("utf-8", errors="replace")
    except Exception:
        return None

    # Search from the end for tqdm patterns first (more specific)
    for line in reversed(tail.splitlines()):
        m = TQDM_RE.search(line)
        if m:
            current, total = int(m.group(2)), int(m.group(3))
            pct = round(100.0 * current / total, 1) if total > 0 else 0.0
            return {"current": current, "total": total, "pct": pct, "message": f"{current}/{total}"}

    # Fall back to fraction patterns — collect all candidates and pick the best.
    # Avoid lines that are negative indicators (Failed, Error, etc.) and prefer
    # the match with the highest current value.
    best: dict | None = None
    best_is_negative = True
    for line in reversed(tail.splitlines()):
        m = FRACTION_RE.search(line)
        if m:
            current, total = int(m.group(1)), int(m.group(2))
            if total > 1 and current <= total * 2:
                is_negative = bool(NEGATIVE_LINE_RE.match(line))
                # Prefer non-negative lines; among same negativity, prefer higher current
                if best is None or (best_is_negative and not is_negative) or (
                    is_negative == best_is_negative and current > best["current"]
                ):
                    pct = round(100.0 * current / total, 1) if total > 0 else 0.0
                    best = {"current": current, "total": total, "pct": pct, "message": f"{current}/{total}"}
                    best_is_negative = is_negative

    return best


def read_csv_rows(csv_path: Path) -> int:
    """Count data rows in a CSV file (excluding header)."""
    if not csv_path.exists():
        return 0
    try:
        with open(csv_path) as f:
            return max(0, sum(1 for _ in f) - 1)
    except Exception:
        return 0


def read_unique_csv_rows(csv_path: Path) -> int:
    """Count unique data rows in a CSV by key-column deduplication.

    Used for --watch-csv progress tracking to avoid inflation from retry entries.
    Uses key columns (task_id, image_id, etc.) when available via pandas for
    accurate deduplication. Falls back to whole-line dedup if pandas unavailable.
    """
    return _count_unique_csv_rows(csv_path)


SUCCESS_VALUES = {"completed", "ok", "success", "done", "passed"}

MANDATORY_FLAGS_ERROR = """\
Missing mandatory flags for --detach mode (per ADR 0027).

Required flags:
  --artifacts-dir DIR   Runtime/log/output directory under modules/<package>/artifacts/
  --project-dir DIR     Enables budget pre-check and consumption audit
  --max-retries N       Explicit retry count (0 = no retry, required)
  --watch-csv FILE      CSV file to monitor for progress
  --total N             Total expected rows (required with --watch-csv)

Rationale: These flags enable critical safeguards for resource-consuming experiments.
Omitting them silently disables budget checking, retry progress guards, and consumption audits.

Example:
  python run.py --detach --artifacts-dir modules/my-module/artifacts/exp1 \\
    --project-dir projects/my-project \\
    --max-retries 3 --watch-csv results/output.csv --total 100 \\
    experiments/exp1 -- python script.py
"""


def validate_mandatory_flags(
    artifacts_dir: Path | None,
    project_dir: Path | None,
    max_retries: int | None,
    watch_csv: Path | None,
    total: int | None,
) -> list[str]:
    """Validate that mandatory flags are set for --detach mode.
    
    Returns a list of missing flag descriptions. Empty list if all required.
    """
    missing = []
    if artifacts_dir is None:
        missing.append("--artifacts-dir")
    if project_dir is None:
        missing.append("--project-dir")
    if max_retries is None:
        missing.append("--max-retries")
    if watch_csv is None:
        missing.append("--watch-csv")
    if watch_csv is not None and total is None:
        missing.append("--total (required when --watch-csv is set)")
    return missing


def count_succeeded_rows(csv_path: Path) -> int | None:
    """Count rows in a CSV where a status-like column indicates success.

    Checks for a 'status' column first (values in SUCCESS_VALUES), then
    falls back to an 'error' column (empty = success). Returns None if
    neither column exists, meaning success rate is not determinable.
    """
    result = count_success_failure_rows(csv_path)
    return result[0] if result is not None else None


def count_success_failure_rows(csv_path: Path) -> tuple[int, int] | None:
    """Count success and failure rows in a CSV.

    Returns (success_count, failure_count) tuple, or None if the CSV
    has no status/error column (meaning success rate is not determinable).

    Success is determined by:
    - 'status' column with values in SUCCESS_VALUES, OR
    - 'error' column that is empty/blank

    Failure is any row that is not a success (when status/error column exists).
    """
    if not csv_path.exists():
        return None
    try:
        import csv as csv_mod
        with open(csv_path, newline="") as f:
            reader = csv_mod.DictReader(f)
            if reader.fieldnames is None:
                return None
            lower_fields = {fn.lower(): fn for fn in reader.fieldnames}
            success = 0
            failed = 0
            if "status" in lower_fields:
                col = lower_fields["status"]
                for row in reader:
                    if row.get(col, "").strip().lower() in SUCCESS_VALUES:
                        success += 1
                    else:
                        failed += 1
                return (success, failed)
            elif "error" in lower_fields:
                col = lower_fields["error"]
                for row in reader:
                    if not row.get(col, "").strip():
                        success += 1
                    else:
                        failed += 1
                return (success, failed)
            return None
    except Exception:
        return None


def detect_log_errors(log_path: Path) -> tuple[bool, str] | None:
    """Scan log file for error patterns that indicate failure despite exit code 0.
    
    Returns (True, error_message) if errors detected, None otherwise.
    Checks last 50KB of log for performance (handles large logs efficiently).
    """
    try:
        with open(log_path, "rb") as f:
            # Read last 50KB — enough to detect repeated errors
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 51200))
            tail = f.read().decode("utf-8", errors="replace")
    except Exception:
        return None
    
    lines = tail.splitlines()
    
    # Pattern 1: Count repeated "Error" lines (e.g., "Error evaluating ...", "ERROR:")
    error_lines = [line for line in lines if "Error " in line or "ERROR" in line or "error:" in line.lower()]
    if len(error_lines) > 20:  # Threshold: >20 error lines indicates systematic failure
        # Extract first unique error message as sample
        sample = next((line.strip() for line in error_lines if len(line.strip()) > 20), "Multiple errors detected")
        return True, f"Detected {len(error_lines)} error lines in log (sample: {sample[:150]})"
    
    # Pattern 2: Python tracebacks with unhandled exceptions (look for "Traceback" + exception type)
    # Exclude known-harmless tracebacks: httpx AsyncClient.aclose() emits
    # "RuntimeError: Event loop is closed" during Python GC after asyncio shutdown.
    # These are cosmetic warnings, not real failures.
    harmless_patterns = ["RuntimeError: Event loop is closed"]
    traceback_indices = [i for i, line in enumerate(lines) if "Traceback (most recent call last)" in line]
    if len(traceback_indices) > 3:  # More than 3 tracebacks suggests repeated failures
        # Pair each traceback with its exception line (last Error/Exception before next TB)
        non_harmless_count = 0
        last_exception = None
        for idx, tb_start in enumerate(traceback_indices):
            tb_end = traceback_indices[idx + 1] if idx + 1 < len(traceback_indices) else len(lines)
            exc_line = None
            for j in range(tb_start + 1, min(tb_start + 40, tb_end)):
                if "Error:" in lines[j] or "Exception:" in lines[j]:
                    exc_line = lines[j].strip()
            if not (exc_line and any(p in exc_line for p in harmless_patterns)):
                non_harmless_count += 1
                if exc_line:
                    last_exception = exc_line
        if non_harmless_count > 3 and last_exception:
            return True, f"Detected {non_harmless_count} tracebacks, last: {last_exception[:200]}"
    
    # Pattern 3: Validation errors (Pydantic, schema validation)
    validation_errors = [line for line in lines if "validation error" in line.lower() or "extra inputs are not permitted" in line.lower()]
    if len(validation_errors) > 10:
        sample = next((line.strip() for line in validation_errors if len(line.strip()) > 20), "Validation errors")
        return True, f"Detected {len(validation_errors)} validation errors (sample: {sample[:150]})"
    
    # Pattern 4: CUDA/GPU errors (OOM, CUDA error)
    gpu_errors = [line for line in lines if "cuda" in line.lower() and ("error" in line.lower() or "out of memory" in line.lower())]
    if gpu_errors:
        sample = gpu_errors[-1].strip()
        return True, f"GPU/CUDA error detected: {sample[:200]}"
    
    return None


def run_canary(
    experiment_dir: Path,
    canary_cmd: list[str],
    timeout: float = 120.0,
    runtime_dir: Path | None = None,
) -> tuple[bool, str]:
    """Run a canary command before the full experiment.

    The canary validates config, API connectivity, and basic execution.
    Returns (success, message). Writes canary output to canary.log in the
    runtime artifact directory while keeping progress.json in the experiment
    record directory.
    """
    runtime_dir = runtime_dir or experiment_dir
    runtime_dir.mkdir(parents=True, exist_ok=True)
    canary_log = runtime_dir / "canary.log"
    canary_progress = {
        "status": "canary",
        "canary_command": canary_cmd,
        "started_at": now_iso(),
        "updated_at": now_iso(),
    }
    write_progress(experiment_dir, canary_progress)

    try:
        with open(canary_log, "w") as log_fh:
            proc = subprocess.Popen(
                canary_cmd,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                cwd=str(runtime_dir),
            )
    except OSError as e:
        msg = f"Canary failed to start: {e}"
        canary_progress["status"] = "canary_failed"
        canary_progress["error"] = msg
        canary_progress["updated_at"] = now_iso()
        write_progress(experiment_dir, canary_progress)
        return False, msg

    try:
        exit_code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        msg = f"Canary timed out after {timeout}s"
        canary_progress["status"] = "canary_failed"
        canary_progress["error"] = msg
        canary_progress["updated_at"] = now_iso()
        write_progress(experiment_dir, canary_progress)
        return False, msg

    if exit_code != 0:
        # Read last few lines of canary log for error context
        try:
            tail = canary_log.read_text()[-500:]
        except Exception:
            tail = "(could not read canary log)"
        msg = f"Canary exited with code {exit_code}: {tail.strip()}"
        canary_progress["status"] = "canary_failed"
        canary_progress["exit_code"] = exit_code
        canary_progress["error"] = msg[:500]
        canary_progress["updated_at"] = now_iso()
        write_progress(experiment_dir, canary_progress)
        return False, msg

    msg = "Canary passed"
    return True, msg


def run_experiment(
    experiment_dir: Path,
    command: list[str],
    artifacts_dir: Path | None = None,
    watch_csv: Path | None = None,
    total: int | None = None,
    poll_interval: float = 5.0,
    max_retries: int = 0,
    retry_delay: float = 10.0,
    canary_cmd: list[str] | None = None,
    canary_timeout: float = 120.0,
    waste_ratio_threshold: float = 0.3,
) -> int:
    """Run the experiment command, write progress.json, return exit code.

    If canary_cmd is provided, it runs first. On canary failure, the full
    experiment is aborted (returns exit code 2).

    If max_retries > 0, transient failures (signal deaths like SIGABRT, SIGKILL)
    are automatically retried. The log file is opened in append mode on retries
    to preserve previous output.
    """
    runtime_dir = artifacts_dir or experiment_dir
    log_path = runtime_dir / LOG_FILE
    experiment_dir.mkdir(parents=True, exist_ok=True)
    runtime_dir.mkdir(parents=True, exist_ok=True)

    if watch_csv is not None and not watch_csv.is_absolute():
      watch_csv = runtime_dir / watch_csv

    # Resolve command file paths: the subprocess runs with cwd=experiment_dir,
    # but the caller may have specified paths relative to their own cwd.
    command = [
        str(Path(arg).resolve()) if Path(arg).exists() and not Path(arg).is_absolute()
        else arg
        for arg in command
    ]

    # Resolve bare executable names (e.g. 'bash' → '/usr/bin/bash') to prevent
    # PATH issues in detached mode (start_new_session=True).
    command = resolve_command(command)
    if canary_cmd:
        canary_cmd = resolve_command(canary_cmd)

    # Acquire exclusive lock to prevent concurrent runs
    lock_fd = acquire_lock(runtime_dir)
    if lock_fd is None:
        # Check who holds the lock
        lock_path = runtime_dir / LOCK_FILE
        holder_pid = "unknown"
        try:
            holder_pid = lock_path.read_text().strip()
        except Exception:
            pass
        print(
            json.dumps({
                "error": f"Experiment directory is locked by PID {holder_pid}. "
                "Another experiment is running in this directory.",
                "experiment_dir": str(experiment_dir),
                "artifacts_dir": str(runtime_dir),
                "hint": f"Wait for the other experiment to complete, or if crashed, remove {LOCK_FILE}",
            }),
            file=sys.stderr,
        )
        return 1

    started_at = now_iso()

    try:
        # Run canary before the full experiment
        if canary_cmd:
            ok, msg = run_canary(experiment_dir, canary_cmd, canary_timeout, runtime_dir)
            if not ok:
                print(f"CANARY FAILED — aborting experiment: {msg}", file=sys.stderr)
                progress = {
                    "status": "canary_failed",
                    "command": command,
                    "canary_command": canary_cmd,
                    "error": msg[:500],
                    "started_at": started_at,
                    "finished_at": now_iso(),
                    "updated_at": now_iso(),
                }
                write_progress(experiment_dir, progress)
                return 2
            print(f"Canary passed, proceeding with full experiment", file=sys.stderr)

        return _run_experiment_inner(
            experiment_dir, runtime_dir, command, watch_csv, total,
            poll_interval, max_retries, retry_delay, started_at,
            waste_ratio_threshold,
        )
    finally:
        release_lock(lock_fd, runtime_dir)


def _count_unique_csv_rows(csv_path: Path) -> int:
    """Count unique rows in a CSV by key columns (dedup-aware).

    Prioritizes `image_id` as the primary dedup key when present (for texture/generation
    experiments where retries create duplicate image_id entries). Falls back to other
    key columns if image_id is absent.
    """
    if not csv_path.exists():
        return 0
    try:
        import pandas as pd
        df = pd.read_csv(csv_path, dtype={"task_id": str, "image_id": str})
        # Prioritize image_id as primary dedup key for progress tracking
        # (retry entries have same image_id, inflating raw row count)
        if "image_id" in df.columns:
            return len(df.drop_duplicates(subset=["image_id"]))
        # Fall back to other key columns if image_id absent
        key_cols = ["dataset", "task_id", "model_a", "model_b", "render_type", "question_key"]
        present_keys = [c for c in key_cols if c in df.columns]
        if present_keys:
            return len(df.drop_duplicates(subset=present_keys))
        return len(df)
    except Exception:
        # Fall back to whole-line dedup (no pandas)
        return _count_unique_csv_rows_simple(csv_path)


def _count_unique_csv_rows_simple(csv_path: Path) -> int:
    """Count unique data rows in a CSV by comparing whole lines (no pandas)."""
    if not csv_path.exists():
        return 0
    try:
        with open(csv_path) as f:
            lines = f.readlines()
        if len(lines) <= 1:
            return 0
        # Skip header, count unique data lines
        data_lines = lines[1:]
        return len(set(line.rstrip("\n\r") for line in data_lines if line.strip()))
    except OSError:
        return 0


def _run_experiment_inner(
    experiment_dir: Path,
    runtime_dir: Path,
    command: list[str],
    watch_csv: Path | None,
    total: int | None,
    poll_interval: float,
    max_retries: int,
    retry_delay: float,
    started_at: str,
    waste_ratio_threshold: float,
) -> int:
    """Inner experiment runner (separated for lock management)."""
    log_path = runtime_dir / LOG_FILE
    prev_unique_rows = 0  # Track unique CSV rows for retry progress guard
    watch_csv_warned = False  # Track if we've warned about missing --watch-csv file

    for attempt in range(1, max_retries + 2):  # attempt 1 .. max_retries+1
        is_retry = attempt > 1

        # Progress state
        progress: dict = {
            "status": "running",
            "pid": os.getpid(),
            "command": command,
            "started_at": started_at,
            "updated_at": now_iso(),
            "log_file": str(log_path),
            "experiment_dir": str(experiment_dir),
            "artifacts_dir": str(runtime_dir),
            "attempt": attempt,
            "max_retries": max_retries,
        }
        if watch_csv:
            progress["watch_csv"] = str(watch_csv)
        if total:
            progress["total"] = total
            progress["current"] = 0
            progress["pct"] = 0.0

        write_progress(experiment_dir, progress)

        # Open log: append on retries to preserve previous output, write on first attempt
        log_fh = open(log_path, "a" if is_retry else "w")
        if is_retry:
            log_fh.write(f"\n--- Retry attempt {attempt}/{max_retries + 1} at {now_iso()} ---\n")
            log_fh.flush()

        # Spawn the command
        try:
            proc = subprocess.Popen(
                command,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                cwd=str(runtime_dir),
            )
        except OSError as e:
            log_fh.close()
            progress["status"] = "failed"
            progress["failure_class"] = "permanent"
            progress["error"] = f"Failed to start command: {e}"
            progress["finished_at"] = now_iso()
            progress["updated_at"] = now_iso()
            write_progress(experiment_dir, progress)
            return 1
        progress["child_pid"] = proc.pid
        write_progress(experiment_dir, progress)

        # Forward SIGTERM/SIGINT to the child
        def handle_signal(signum: int, _frame) -> None:
            progress["status"] = "stopping"
            progress["updated_at"] = now_iso()
            write_progress(experiment_dir, progress)
            proc.send_signal(signum)

        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)

        # Poll for progress until child exits
        poll_count = 0
        while proc.poll() is None:
            time.sleep(poll_interval)
            poll_count += 1

            # Warn if --watch-csv file doesn't exist after ~30s (6 polls at 5s interval)
            if (
                watch_csv
                and not watch_csv_warned
                and poll_count >= 6
                and not watch_csv.exists()
            ):
                watch_csv_warned = True
                print(
                    f"WARNING: --watch-csv file does not exist after 30s: {watch_csv}\n"
                    f"  Check: (1) Does the command create this CSV? (2) Is the path relative to the experiment directory?",
                    file=sys.stderr,
                )

            # Update CSV-based progress if watching (explicit --watch-csv)
            if watch_csv and total:
                current = read_unique_csv_rows(watch_csv)
                total_rows = read_csv_rows(watch_csv)
                progress["current"] = current
                progress["total_rows_raw"] = total_rows
                progress["pct"] = round(100.0 * current / total, 1) if total > 0 else 0.0
                sf_counts = count_success_failure_rows(watch_csv)
                if sf_counts is not None:
                    success, failed = sf_counts
                    progress["success"] = success
                    progress["failed"] = failed
                    if current > 0:
                        progress["success_rate"] = round(100.0 * success / current, 1)
                progress["message"] = f"{current}/{total} rows (unique)"
            else:
                # Auto-detect progress from log output (tqdm bars, N/M fractions)
                log_progress = parse_log_progress(log_path)
                if log_progress:
                    progress["current"] = log_progress["current"]
                    progress["total"] = log_progress["total"]
                    progress["pct"] = log_progress["pct"]
                    progress["message"] = log_progress["message"]

            progress["updated_at"] = now_iso()
            write_progress(experiment_dir, progress)

        # Child exited
        exit_code = proc.returncode
        log_fh.close()

        if watch_csv and total:
            current = read_unique_csv_rows(watch_csv)
            total_rows = read_csv_rows(watch_csv)
            progress["current"] = current
            progress["total_rows_raw"] = total_rows
            progress["pct"] = round(100.0 * current / total, 1) if total > 0 else 0.0
            sf_counts = count_success_failure_rows(watch_csv)
            if sf_counts is not None:
                success, failed = sf_counts
                progress["success"] = success
                progress["failed"] = failed
                if current > 0:
                    progress["success_rate"] = round(100.0 * success / current, 1)
            progress["message"] = f"{current}/{total} rows (unique)"

        # If not watching a specific CSV, check results/ for success/failure counts
        if not watch_csv:
            results_dir = runtime_dir / "results"
            csv_files = sorted(results_dir.glob("*.csv")) if results_dir.exists() else []
            if csv_files:
                sf_counts = count_success_failure_rows(csv_files[0])
                if sf_counts is not None:
                    success, failed = sf_counts
                    progress["success"] = success
                    progress["failed"] = failed
                    if progress.get("current", 0) > 0:
                        progress["success_rate"] = round(100.0 * success / progress["current"], 1)

        # Success (exit code 0) — but check log for hidden failures
        if exit_code == 0:
            # Smart failure detection: scan log for error patterns
            log_error_result = detect_log_errors(log_path)
            
            if log_error_result:
                # Exit code 0 but log contains systematic errors → treat as failure
                has_errors, error_message = log_error_result
                progress["status"] = "failed"
                progress["exit_code"] = 0  # Preserve actual exit code
                progress["failure_class"] = "permanent"
                progress["error"] = f"Exit code 0 but log analysis detected failures: {error_message}"
                progress["finished_at"] = now_iso()
                progress["updated_at"] = now_iso()
                progress["duration_s"] = round(
                    (datetime.fromisoformat(progress["finished_at"])
                     - datetime.fromisoformat(started_at)).total_seconds()
                )
                write_progress(experiment_dir, progress)
                return 1  # Return non-zero to signal failure to caller
            
            # Check success rate threshold if we have status data
            # If success_rate is available and below 50%, treat as failure
            success_rate = progress.get("success_rate")
            if success_rate is not None and success_rate < 50.0:
                progress["status"] = "failed"
                progress["exit_code"] = 0
                progress["failure_class"] = "low_success_rate"
                success_count = progress.get("success", 0)
                failed_count = progress.get("failed", 0)
                total_rows = progress.get("current", 0)
                progress["error"] = (
                    f"Success rate {success_rate}% below 50% threshold "
                    f"({success_count} success, {failed_count} failed, {total_rows} total rows)"
                )
                progress["finished_at"] = now_iso()
                progress["updated_at"] = now_iso()
                progress["duration_s"] = round(
                    (datetime.fromisoformat(progress["finished_at"])
                     - datetime.fromisoformat(started_at)).total_seconds()
                )
                write_progress(experiment_dir, progress)
                return 1  # Return non-zero to signal failure to caller
            
            # Genuine success
            progress["status"] = "completed"
            progress["exit_code"] = 0
            progress["finished_at"] = now_iso()
            progress["updated_at"] = now_iso()
            progress["duration_s"] = round(
                (datetime.fromisoformat(progress["finished_at"])
                 - datetime.fromisoformat(started_at)).total_seconds()
            )
            write_progress(experiment_dir, progress)
            return 0

        # Interrupted by signal handler
        if progress["status"] == "stopping":
            progress["status"] = "interrupted"
            progress["exit_code"] = exit_code
            progress["finished_at"] = now_iso()
            progress["updated_at"] = now_iso()
            progress["duration_s"] = round(
                (datetime.fromisoformat(progress["finished_at"])
                 - datetime.fromisoformat(started_at)).total_seconds()
            )
            write_progress(experiment_dir, progress)
            return exit_code

        # Failure — check if transient and retries remain
        transient = is_transient_failure(exit_code)
        retries_remaining = attempt < max_retries + 1

        if transient and retries_remaining:
            # Retry progress guard: check if this attempt produced any new unique rows.
            # If not, the failure is likely deterministic (not transient) — stop retrying
            # to prevent unbounded resource waste.
            if watch_csv:
                current_unique = _count_unique_csv_rows(watch_csv)
                current_total = _count_csv_rows(watch_csv)
            else:
                # Try to find a CSV in results/ directory
                results_dir = runtime_dir / "results"
                csv_files = sorted(results_dir.glob("*.csv")) if results_dir.exists() else []
                if csv_files:
                    current_unique = _count_unique_csv_rows(csv_files[0])
                    current_total = _count_csv_rows(csv_files[0])
                else:
                    current_unique = 0
                    current_total = 0

            new_rows = current_unique - prev_unique_rows
            waste_ratio = (
                (current_total - current_unique) / current_total
                if current_total > 0
                else 0.0
            )
            progress["retry_progress"] = {
                "unique_rows_before": prev_unique_rows,
                "unique_rows_after": current_unique,
                "new_unique_rows": new_rows,
                "total_rows": current_total,
                "waste_ratio": round(waste_ratio, 4),
            }

            # Waste-ratio abort: if too many CSV rows are duplicates, the resume
            # logic is likely broken — abort to prevent unbounded resource waste.
            # This catches the flash-240 scenario where retries re-evaluated
            # already-completed tasks due to a resume bug (87.3% waste).
            if current_total > 0 and waste_ratio > waste_ratio_threshold:
                progress["status"] = "failed"
                progress["exit_code"] = exit_code
                progress["failure_class"] = "resume_corruption"
                progress["error"] = (
                    f"Waste ratio {waste_ratio:.1%} exceeds {waste_ratio_threshold:.0%} threshold "
                    f"({current_total - current_unique} duplicate rows out of "
                    f"{current_total} total). Resume logic may be broken — "
                    f"aborting to prevent resource waste."
                )
                progress["finished_at"] = now_iso()
                progress["updated_at"] = now_iso()
                progress["duration_s"] = round(
                    (datetime.fromisoformat(progress["finished_at"])
                     - datetime.fromisoformat(started_at)).total_seconds()
                )
                write_progress(experiment_dir, progress)
                return exit_code

            if attempt > 2 and current_unique > 0 and new_rows == 0:
                # Two consecutive retries with no progress → deterministic failure
                progress["status"] = "failed"
                progress["exit_code"] = exit_code
                progress["failure_class"] = "deterministic_no_progress"
                progress["error"] = (
                    f"Exit code {exit_code} (transient signal, but 0 new unique rows "
                    f"on attempt {attempt} — reclassified as deterministic failure). "
                    f"Total unique rows: {current_unique}."
                )
                progress["finished_at"] = now_iso()
                progress["updated_at"] = now_iso()
                progress["duration_s"] = round(
                    (datetime.fromisoformat(progress["finished_at"])
                     - datetime.fromisoformat(started_at)).total_seconds()
                )
                write_progress(experiment_dir, progress)
                return exit_code

            prev_unique_rows = current_unique

            progress["status"] = "retrying"
            progress["failure_class"] = "transient"
            progress["exit_code"] = exit_code
            progress["error"] = f"Exit code {exit_code} (transient, retrying in {retry_delay}s)"
            progress["updated_at"] = now_iso()
            write_progress(experiment_dir, progress)
            time.sleep(retry_delay)
            continue

        # Final failure — no more retries
        progress["status"] = "failed"
        progress["exit_code"] = exit_code
        progress["error"] = f"Exit code {exit_code}"
        if transient:
            progress["failure_class"] = "transient_exhausted"
        else:
            progress["failure_class"] = "permanent"
        progress["finished_at"] = now_iso()
        progress["updated_at"] = now_iso()
        progress["duration_s"] = round(
            (datetime.fromisoformat(progress["finished_at"])
             - datetime.fromisoformat(started_at)).total_seconds()
        )
        write_progress(experiment_dir, progress)
        return exit_code

    # Should not reach here, but satisfy type checker
    return 1


def detach_and_run(raw_args: list[str]) -> int:
    """Re-exec ourselves in the background (double-fork / nohup style).

    Resolves path arguments to absolute paths before detaching so the
    background process doesn't depend on the parent's cwd.
    """
    # Parse just enough to resolve paths, then re-build the arg list
    clean_args = [a for a in raw_args if a != "--detach"]

    # Find experiment_dir (first non-flag arg before --)
    # and --watch-csv value, resolve them to absolute paths
    resolved: list[str] = []
    i = 0
    experiment_dir_abs: str | None = None
    artifacts_dir_abs: str | None = None
    while i < len(clean_args):
        arg = clean_args[i]
        if arg == "--":
            # Everything after -- is the command.
            # Resolve file paths in the command so they work from any cwd.
            # The runner sets cwd=experiment_dir, but the caller may have
            # specified paths relative to their own cwd (e.g. repo root).
            resolved.append(arg)
            for cmd_arg in clean_args[i + 1:]:
                p = Path(cmd_arg)
                if p.exists() and not p.is_absolute():
                    resolved.append(str(p.resolve()))
                else:
                    resolved.append(cmd_arg)
            break
        elif arg == "--watch-csv" and i + 1 < len(clean_args):
            resolved.append(arg)
            watch_csv_arg = clean_args[i + 1]
            watch_csv_path = Path(watch_csv_arg)
            resolved.append(str(watch_csv_path.resolve()) if watch_csv_path.is_absolute() else watch_csv_arg)
            i += 2
            continue
        elif arg in {"--artifacts-dir", "--project-dir"} and i + 1 < len(clean_args):
            resolved.append(arg)
            resolved_path = str(Path(clean_args[i + 1]).resolve())
            resolved.append(resolved_path)
            if arg == "--artifacts-dir":
                artifacts_dir_abs = resolved_path
            i += 2
            continue
        elif arg.startswith("--") and i + 1 < len(clean_args) and not clean_args[i + 1].startswith("--"):
            # Flag with value (e.g. --total 10, --poll-interval 5)
            resolved.append(arg)
            resolved.append(clean_args[i + 1])
            i += 2
            continue
        elif arg.startswith("--"):
            resolved.append(arg)
        else:
            # First positional arg = experiment_dir, rest are command args
            if experiment_dir_abs is None:
                experiment_dir_abs = str(Path(arg).resolve())
                resolved.append(experiment_dir_abs)
            else:
                # Command args remain as-is
                resolved.append(arg)
        i += 1

    script = str(Path(__file__).resolve())
    stderr_path = Path(artifacts_dir_abs or experiment_dir_abs or ".") / "runner_stderr.log"
    stderr_path.parent.mkdir(parents=True, exist_ok=True)

    stderr_fh = open(stderr_path, "w")
    try:
        proc = subprocess.Popen(
            [sys.executable, script] + resolved,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=stderr_fh,
            start_new_session=True,
        )
    except OSError as e:
        stderr_fh.close()
        print(json.dumps({"launched": False, "error": str(e)}))
        return 1

    # Brief check that the child actually started
    time.sleep(0.2)
    if proc.poll() is not None:
        stderr_fh.close()
        print(json.dumps({"launched": False, "error": f"Child exited immediately with code {proc.returncode}"}))
        return 1

    stderr_fh.close()
    print(json.dumps({"launched": True, "pid": proc.pid}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run an experiment with progress tracking"
    )
    parser.add_argument(
        "experiment_dir",
        type=Path,
        help="Path to the experiment directory (must exist)",
    )
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help="Command to run (everything after experiment_dir)",
    )
    parser.add_argument(
        "--watch-csv",
        type=Path,
        default=None,
        help="CSV file to monitor for row-count progress",
    )
    parser.add_argument(
        "--total",
        type=int,
        default=None,
        help="Total expected rows (for progress percentage)",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=5.0,
        help="Seconds between progress updates (default: 5)",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=None,
        help="Max retries for transient failures (signal deaths). Required for --detach.",
    )
    parser.add_argument(
        "--retry-delay",
        type=float,
        default=10.0,
        help="Seconds to wait between retries (default: 10)",
    )
    parser.add_argument(
        "--waste-ratio-threshold",
        type=float,
        default=0.3,
        help="Abort retries when duplicate ratio exceeds this threshold (default: 0.3 = 30%%)",
    )
    parser.add_argument(
        "--canary-cmd",
        type=str,
        default=None,
        help=(
            "Command to run as a canary before the full experiment. "
            "If the canary exits non-zero, the full experiment is aborted (exit 2). "
            "Use with your experiment script's --validate flag to test config + API. "
            "Example: --canary-cmd 'python eval.py config.json --provider cloudflare --model openai/gpt-5.2 --validate'"
        ),
    )
    parser.add_argument(
        "--canary-timeout",
        type=float,
        default=120.0,
        help="Timeout in seconds for the canary command (default: 120)",
    )
    parser.add_argument(
        "--project-dir",
        type=Path,
        default=None,
        help="Project directory containing budget.yaml/ledger.yaml for pre-execution budget check",
    )
    parser.add_argument(
        "--artifacts-dir",
        type=Path,
        default=None,
        help="Runtime/log/output directory under modules/<package>/artifacts/",
    )
    parser.add_argument(
        "--ignore-budget",
        action="store_true",
        help="Skip budget pre-check even if --project-dir is set",
    )
    parser.add_argument(
        "--detach",
        action="store_true",
        help="Detach and run in the background (returns immediately)",
    )
    args = parser.parse_args()

    if not args.command:
        parser.error("No command provided")

    if args.max_retries is not None and args.max_retries < 0:
        parser.error(
            f"--max-retries must be >= 0 (got {args.max_retries}). "
            "Use 0 for no retries, or a positive integer for automatic retry on transient failures."
        )

    # Strip leading '--' if present (from REMAINDER parsing)
    command = args.command
    if command and command[0] == "--":
        command = command[1:]

    # Parse canary command (shell-style string → list)
    canary_cmd = None
    if args.canary_cmd:
        import shlex
        canary_cmd = shlex.split(args.canary_cmd)

    # Budget pre-check
    if args.project_dir and not args.ignore_budget:
        budget_ok, budget_msg = check_budget(args.project_dir, args.total)
        print(f"Budget check: {budget_msg}", file=sys.stderr)
        if not budget_ok:
            print(
                json.dumps({
                    "error": f"Budget pre-check failed: {budget_msg}",
                    "hint": "Use --ignore-budget to override",
                }),
                file=sys.stderr,
            )
            return 3  # Distinct exit code for budget failure

    if args.detach:
        missing = validate_mandatory_flags(
            args.artifacts_dir, args.project_dir, args.max_retries, args.watch_csv, args.total
        )
        if missing:
            print(
                MANDATORY_FLAGS_ERROR + f"\nMissing: {', '.join(missing)}\n",
                file=sys.stderr,
            )
            return 4
        return detach_and_run(sys.argv[1:])

    watch_csv = args.watch_csv
    runtime_dir = args.artifacts_dir or args.experiment_dir
    if watch_csv is not None and not watch_csv.is_absolute():
        watch_csv = runtime_dir / watch_csv

    exit_code = run_experiment(
        experiment_dir=args.experiment_dir,
        command=command,
        artifacts_dir=args.artifacts_dir,
        watch_csv=watch_csv,
        total=args.total,
        poll_interval=args.poll_interval,
        max_retries=args.max_retries if args.max_retries is not None else 0,
        retry_delay=args.retry_delay,
        canary_cmd=canary_cmd,
        canary_timeout=args.canary_timeout,
        waste_ratio_threshold=args.waste_ratio_threshold,
    )

    # Post-completion consumption audit (runs on ALL exit codes, not just success,
    # to detect resource waste from retried failures — see postmortem flash-240-retry-waste)
    if args.project_dir:
        audit = consumption_audit(args.experiment_dir, args.project_dir, args.artifacts_dir)
        # Update progress.json with audit results
        progress_path = args.experiment_dir / PROGRESS_FILE
        if progress_path.exists():
            try:
                progress = json.loads(progress_path.read_text())
                progress["consumption_audit"] = audit
                write_progress(args.experiment_dir, progress)
            except (json.JSONDecodeError, OSError):
                pass

        if audit["status"] == "missing_ledger":
            print(f"AUDIT WARNING: {audit['message']}", file=sys.stderr)
        elif audit["status"] == "discrepancy":
            print(f"AUDIT WARNING: {audit['message']}", file=sys.stderr)
        elif audit["status"] == "ok":
            print(f"Audit: {audit['message']}", file=sys.stderr)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
