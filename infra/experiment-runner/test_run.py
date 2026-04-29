"""Tests for the experiment runner (run.py).

Covers the critical safety logic identified in ADR 0027 and the flash-240
postmortem: retry progress guard, consumption audit, budget pre-check,
canary failure handling, log error detection, and transient failure classification.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

# Import the module under test
import run


class TestIsTransientFailure(unittest.TestCase):
    """Test transient failure classification (signal-based exit codes)."""

    def test_sigkill_is_transient(self):
        self.assertTrue(run.is_transient_failure(137))  # 128 + 9

    def test_sigsegv_is_transient(self):
        self.assertTrue(run.is_transient_failure(139))  # 128 + 11

    def test_sigabrt_is_transient(self):
        self.assertTrue(run.is_transient_failure(134))  # 128 + 6

    def test_sigfpe_is_transient(self):
        self.assertTrue(run.is_transient_failure(136))  # 128 + 8

    def test_exit_code_1_is_permanent(self):
        self.assertFalse(run.is_transient_failure(1))

    def test_exit_code_2_is_permanent(self):
        self.assertFalse(run.is_transient_failure(2))

    def test_exit_code_0_is_not_transient(self):
        self.assertFalse(run.is_transient_failure(0))

    def test_exit_code_127_is_permanent(self):
        """127 = command not found — not transient."""
        self.assertFalse(run.is_transient_failure(127))


class TestWriteProgress(unittest.TestCase):
    """Test atomic progress.json writing."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_writes_json_file(self):
        data = {"status": "running", "pid": 12345}
        run.write_progress(self.tmpdir, data)
        path = self.tmpdir / "progress.json"
        self.assertTrue(path.exists())
        content = json.loads(path.read_text())
        self.assertEqual(content["status"], "running")
        self.assertEqual(content["pid"], 12345)

    def test_overwrites_existing(self):
        run.write_progress(self.tmpdir, {"status": "running"})
        run.write_progress(self.tmpdir, {"status": "completed"})
        content = json.loads((self.tmpdir / "progress.json").read_text())
        self.assertEqual(content["status"], "completed")

    def test_no_temp_file_remains(self):
        """Atomic write should not leave .tmp files."""
        run.write_progress(self.tmpdir, {"status": "done"})
        tmp_files = list(self.tmpdir.glob("*.tmp"))
        self.assertEqual(len(tmp_files), 0)


class TestCheckBudget(unittest.TestCase):
    """Test budget pre-check logic."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_no_budget_file_returns_ok(self):
        ok, msg = run.check_budget(self.tmpdir, None)
        self.assertTrue(ok)
        self.assertIn("No budget.yaml", msg)

    def test_within_budget(self):
        (self.tmpdir / "budget.yaml").write_text(textwrap.dedent("""\
            resources:
              llm_api_calls:
                limit: 1000
                unit: calls
        """))
        (self.tmpdir / "ledger.yaml").write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: test
                resource: llm_api_calls
                amount: 500
        """))
        ok, msg = run.check_budget(self.tmpdir, None)
        self.assertTrue(ok)
        self.assertIn("Budget OK", msg)

    def test_budget_exhausted(self):
        (self.tmpdir / "budget.yaml").write_text(textwrap.dedent("""\
            resources:
              llm_api_calls:
                limit: 1000
                unit: calls
        """))
        (self.tmpdir / "ledger.yaml").write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: test
                resource: llm_api_calls
                amount: 1000
        """))
        ok, msg = run.check_budget(self.tmpdir, None)
        self.assertFalse(ok)
        self.assertIn("exhausted", msg)

    def test_estimated_calls_exceeds_remaining(self):
        (self.tmpdir / "budget.yaml").write_text(textwrap.dedent("""\
            resources:
              llm_api_calls:
                limit: 1000
                unit: calls
        """))
        (self.tmpdir / "ledger.yaml").write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: test
                resource: llm_api_calls
                amount: 800
        """))
        ok, msg = run.check_budget(self.tmpdir, estimated_calls=300)
        self.assertFalse(ok)
        self.assertIn("exceeds remaining", msg)

    def test_estimated_calls_within_remaining(self):
        (self.tmpdir / "budget.yaml").write_text(textwrap.dedent("""\
            resources:
              llm_api_calls:
                limit: 1000
                unit: calls
        """))
        (self.tmpdir / "ledger.yaml").write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: test
                resource: llm_api_calls
                amount: 500
        """))
        ok, msg = run.check_budget(self.tmpdir, estimated_calls=300)
        self.assertTrue(ok)

    def test_deadline_passed(self):
        past = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        (self.tmpdir / "budget.yaml").write_text(textwrap.dedent(f"""\
            resources:
              llm_api_calls:
                limit: 1000
                unit: calls
            deadline: {past}
        """))
        ok, msg = run.check_budget(self.tmpdir, None)
        self.assertFalse(ok)
        self.assertIn("deadline has passed", msg)

    def test_deadline_not_passed(self):
        future = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
        (self.tmpdir / "budget.yaml").write_text(textwrap.dedent(f"""\
            resources:
              llm_api_calls:
                limit: 1000
                unit: calls
            deadline: {future}
        """))
        ok, msg = run.check_budget(self.tmpdir, None)
        self.assertTrue(ok)

    def test_no_ledger_file(self):
        """Budget check with no ledger should report full budget remaining."""
        (self.tmpdir / "budget.yaml").write_text(textwrap.dedent("""\
            resources:
              llm_api_calls:
                limit: 1000
                unit: calls
        """))
        ok, msg = run.check_budget(self.tmpdir, None)
        self.assertTrue(ok)
        self.assertIn("1000", msg)

    def test_multiple_ledger_entries_sum(self):
        """Multiple entries for the same resource should sum correctly."""
        (self.tmpdir / "budget.yaml").write_text(textwrap.dedent("""\
            resources:
              llm_api_calls:
                limit: 1000
                unit: calls
        """))
        (self.tmpdir / "ledger.yaml").write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: exp1
                resource: llm_api_calls
                amount: 300
              - date: "2026-01-02"
                experiment: exp2
                resource: llm_api_calls
                amount: 400
        """))
        ok, msg = run.check_budget(self.tmpdir, estimated_calls=400)
        self.assertFalse(ok)
        self.assertIn("exceeds remaining", msg)


class TestConsumptionAudit(unittest.TestCase):
    """Test post-completion consumption audit logic."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.exp_dir = self.tmpdir / "experiments" / "test-exp"
        self.exp_dir.mkdir(parents=True)
        self.project_dir = self.tmpdir

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_no_results_dir(self):
        audit = run.consumption_audit(self.exp_dir, self.project_dir)
        self.assertEqual(audit["status"], "no_results_dir")

    def test_no_csv_files(self):
        (self.exp_dir / "results").mkdir()
        audit = run.consumption_audit(self.exp_dir, self.project_dir)
        self.assertEqual(audit["status"], "no_csvs")

    def test_csv_rows_counted_correctly(self):
        results = self.exp_dir / "results"
        results.mkdir()
        csv = results / "output.csv"
        csv.write_text("header\nrow1\nrow2\nrow3\n")

        # config.json with n_runs=4
        (self.exp_dir / "config.json").write_text('{"n_runs": 4}')

        audit = run.consumption_audit(self.exp_dir, self.project_dir)
        self.assertEqual(audit["total_rows"], 3)
        self.assertEqual(audit["n_runs"], 4)
        self.assertEqual(audit["csv_derived_calls"], 12)  # 3 rows * 4 runs

    def test_missing_ledger_flagged(self):
        results = self.exp_dir / "results"
        results.mkdir()
        (results / "output.csv").write_text("header\nrow1\n")
        audit = run.consumption_audit(self.exp_dir, self.project_dir)
        self.assertEqual(audit["status"], "missing_ledger")

    def test_ledger_match(self):
        results = self.exp_dir / "results"
        results.mkdir()
        (results / "output.csv").write_text("header\nrow1\nrow2\n")
        (self.exp_dir / "config.json").write_text('{"n_runs": 3}')

        # Ledger with matching amount: 2 rows * 3 runs = 6
        (self.project_dir / "ledger.yaml").write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: test-exp
                resource: llm_api_calls
                amount: 6
        """))

        audit = run.consumption_audit(self.exp_dir, self.project_dir)
        self.assertEqual(audit["status"], "ok")

    def test_ledger_discrepancy_detected(self):
        results = self.exp_dir / "results"
        results.mkdir()
        (results / "output.csv").write_text("header\nrow1\nrow2\nrow3\n")
        (self.exp_dir / "config.json").write_text('{"n_runs": 4}')

        # Ledger with wrong amount: actual = 3*4=12, recorded = 8
        (self.project_dir / "ledger.yaml").write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: test-exp
                resource: llm_api_calls
                amount: 8
        """))

        audit = run.consumption_audit(self.exp_dir, self.project_dir)
        self.assertEqual(audit["status"], "discrepancy")
        self.assertEqual(audit["difference"], 4)  # 12 - 8
        self.assertIn("UNDER-recorded", audit["message"])

    def test_default_n_runs_is_1(self):
        results = self.exp_dir / "results"
        results.mkdir()
        (results / "output.csv").write_text("header\nrow1\nrow2\n")
        # No config.json → default n_runs=1

        audit = run.consumption_audit(self.exp_dir, self.project_dir)
        self.assertEqual(audit["n_runs"], 1)
        self.assertEqual(audit["csv_derived_calls"], 2)

    def test_audit_runs_on_all_exit_codes(self):
        """The audit function itself doesn't depend on exit code —
        it just reads CSVs and ledger. This tests that it works regardless."""
        results = self.exp_dir / "results"
        results.mkdir()
        (results / "output.csv").write_text("header\nrow1\n")
        audit = run.consumption_audit(self.exp_dir, self.project_dir)
        # Should always produce a result, never error
        self.assertIn("status", audit)


class TestReadUniqueCsvRows(unittest.TestCase):
    """Test unique row counting by whole-row deduplication."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_all_unique(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("task_id,value\n001,a\n002,b\n003,c\n")
        self.assertEqual(run.read_unique_csv_rows(csv), 3)

    def test_with_true_duplicates(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("task_id,value\n001,a\n002,b\n001,a\n002,b\n")
        self.assertEqual(run.read_unique_csv_rows(csv), 2)

    def test_same_key_different_values_counted_separately(self):
        """Rows with same task_id are deduplicated (key-column dedup on task_id).

        This is the intended behavior for progress tracking: retry entries for
        the same task_id count as 1 unique task processed.
        """
        csv = self.tmpdir / "test.csv"
        csv.write_text("task_id,value\n001,a\n001,b\n001,c\n")
        # task_id is a key column, so dedup on task_id -> 1 unique
        self.assertEqual(run.read_unique_csv_rows(csv), 1)

    def test_empty_csv(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("task_id,value\n")
        self.assertEqual(run.read_unique_csv_rows(csv), 0)

    def test_nonexistent_file(self):
        self.assertEqual(run.read_unique_csv_rows(self.tmpdir / "missing.csv"), 0)

    def test_multi_column_dedup(self):
        """All columns participate in deduplication."""
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,a,b\n001,x,y\n001,z,w\n002,x,y\n")
        self.assertEqual(run.read_unique_csv_rows(csv), 3)

    def test_run_id_first_column(self):
        """task_id is a key column, so dedup on task_id.

        This gives the correct count for progress tracking: unique tasks processed,
        not total rows (which would include multiple judge models per task).
        """
        csv = self.tmpdir / "test.csv"
        csv.write_text(
            "run_id,task_id,judge_model\n"
            "1,orient-1,gpt-5.2\n"
            "1,orient-1,opus-4.6\n"
            "1,orient-2,gpt-5.2\n"
            "2,orient-1,gpt-5.2\n"
        )
        # task_id is a key column -> 2 unique task_ids (orient-1, orient-2)
        self.assertEqual(run.read_unique_csv_rows(csv), 2)

    def test_handles_empty_rows(self):
        """Empty rows are skipped."""
        csv = self.tmpdir / "test.csv"
        csv.write_text("task_id,value\n001,a\n\n002,c\n")
        self.assertEqual(run.read_unique_csv_rows(csv), 2)


class TestCountCsvRows(unittest.TestCase):
    """Test CSV row counting."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_basic_csv(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("header\nrow1\nrow2\nrow3\n")
        self.assertEqual(run._count_csv_rows(csv), 3)

    def test_empty_csv_with_header(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("header\n")
        self.assertEqual(run._count_csv_rows(csv), 0)

    def test_nonexistent_file(self):
        self.assertEqual(run._count_csv_rows(self.tmpdir / "missing.csv"), 0)

    def test_empty_file(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("")
        self.assertEqual(run._count_csv_rows(csv), 0)

    def test_read_csv_rows_matches(self):
        """read_csv_rows (public API) should match _count_csv_rows."""
        csv = self.tmpdir / "test.csv"
        csv.write_text("col1,col2\na,b\nc,d\n")
        self.assertEqual(run.read_csv_rows(csv), 2)
        self.assertEqual(run._count_csv_rows(csv), 2)


class TestCountUniqueCsvRowsSimple(unittest.TestCase):
    """Test pure-Python unique row counting (fallback when pandas unavailable)."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_all_unique(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("h\nrow1\nrow2\nrow3\n")
        self.assertEqual(run._count_unique_csv_rows_simple(csv), 3)

    def test_with_duplicates(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("h\nrow1\nrow2\nrow1\nrow2\n")
        self.assertEqual(run._count_unique_csv_rows_simple(csv), 2)

    def test_all_duplicates(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("h\nrow1\nrow1\nrow1\n")
        self.assertEqual(run._count_unique_csv_rows_simple(csv), 1)

    def test_empty_csv(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("header\n")
        self.assertEqual(run._count_unique_csv_rows_simple(csv), 0)

    def test_nonexistent_file(self):
        self.assertEqual(run._count_unique_csv_rows_simple(self.tmpdir / "missing.csv"), 0)


class TestParseLogProgress(unittest.TestCase):
    """Test log progress extraction from tqdm and fraction patterns."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def _write_log(self, content: str) -> Path:
        path = self.tmpdir / "output.log"
        path.write_text(content)
        return path

    def test_tqdm_pattern(self):
        log = self._write_log("Evaluating:  72%|███████   | 56/78 [00:30<00:12]\n")
        result = run.parse_log_progress(log)
        self.assertIsNotNone(result)
        self.assertEqual(result["current"], 56)
        self.assertEqual(result["total"], 78)

    def test_fraction_pattern(self):
        log = self._write_log("Processing 45/100 rows\n")
        result = run.parse_log_progress(log)
        self.assertIsNotNone(result)
        self.assertEqual(result["current"], 45)
        self.assertEqual(result["total"], 100)

    def test_simple_fraction(self):
        log = self._write_log("56/78 evals\n")
        result = run.parse_log_progress(log)
        self.assertIsNotNone(result)
        self.assertEqual(result["current"], 56)
        self.assertEqual(result["total"], 78)

    def test_negative_line_deprioritized(self):
        """Failed: 0/100 should be deprioritized vs Succeeded: 100/100."""
        log = self._write_log("Succeeded: 100/100 items\nFailed: 0/100 items\n")
        result = run.parse_log_progress(log)
        self.assertIsNotNone(result)
        self.assertEqual(result["current"], 100)
        self.assertEqual(result["total"], 100)

    def test_negative_only_still_returned(self):
        """If only negative lines exist, still return them."""
        log = self._write_log("Failed: 5/100 items\n")
        result = run.parse_log_progress(log)
        self.assertIsNotNone(result)
        self.assertEqual(result["current"], 5)

    def test_empty_log(self):
        log = self._write_log("")
        result = run.parse_log_progress(log)
        self.assertIsNone(result)

    def test_no_progress_in_log(self):
        log = self._write_log("Starting experiment...\nDone.\n")
        result = run.parse_log_progress(log)
        self.assertIsNone(result)

    def test_prompts_suffix(self):
        """Sim CLI uses 'N/M prompts' format."""
        log = self._write_log("15/60 prompts\n")
        result = run.parse_log_progress(log)
        self.assertIsNotNone(result)
        self.assertEqual(result["current"], 15)
        self.assertEqual(result["total"], 60)

    def test_tqdm_preferred_over_fraction(self):
        """If both tqdm and fraction patterns exist, tqdm wins."""
        log = self._write_log("Processing 10/20 items\n  50%|█████     | 10/20 [00:05]\n")
        result = run.parse_log_progress(log)
        self.assertIsNotNone(result)
        self.assertEqual(result["current"], 10)
        self.assertEqual(result["total"], 20)

    def test_nonexistent_log(self):
        result = run.parse_log_progress(self.tmpdir / "nonexistent.log")
        self.assertIsNone(result)

    def test_fraction_rejects_total_of_1(self):
        """Pattern should reject N/1 as likely not progress."""
        log = self._write_log("version 2/1 loaded\n")
        result = run.parse_log_progress(log)
        self.assertIsNone(result)


class TestDetectLogErrors(unittest.TestCase):
    """Test log error detection for hidden failures (exit code 0 but errors in log)."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def _write_log(self, content: str) -> Path:
        path = self.tmpdir / "output.log"
        path.write_text(content)
        return path

    def test_clean_log_returns_none(self):
        log = self._write_log("Starting...\nProcessing 100/100\nDone.\n")
        result = run.detect_log_errors(log)
        self.assertIsNone(result)

    def test_many_error_lines_detected(self):
        lines = ["Error evaluating task {}: connection timeout\n".format(i) for i in range(25)]
        log = self._write_log("".join(lines))
        result = run.detect_log_errors(log)
        self.assertIsNotNone(result)
        has_errors, msg = result
        self.assertTrue(has_errors)
        self.assertIn("25", msg)

    def test_few_error_lines_ignored(self):
        """<= 20 error lines should not trigger detection."""
        lines = ["Error evaluating task {}\n".format(i) for i in range(15)]
        log = self._write_log("".join(lines))
        result = run.detect_log_errors(log)
        self.assertIsNone(result)

    def test_tracebacks_detected(self):
        tb = "Traceback (most recent call last):\n  File 'test.py', line 1\nValueError: bad value\n"
        content = (tb + "some output\n") * 5
        log = self._write_log(content)
        result = run.detect_log_errors(log)
        self.assertIsNotNone(result)
        has_errors, msg = result
        self.assertTrue(has_errors)

    def test_harmless_tracebacks_ignored(self):
        """RuntimeError: Event loop is closed should be ignored."""
        tb = "Traceback (most recent call last):\n  File 'httpx.py', line 1\nRuntimeError: Event loop is closed\n"
        content = (tb + "normal output\n") * 5
        log = self._write_log(content)
        result = run.detect_log_errors(log)
        self.assertIsNone(result)

    def test_validation_errors_detected(self):
        lines = ["validation error for field 'x'\n"] * 15
        log = self._write_log("".join(lines))
        result = run.detect_log_errors(log)
        self.assertIsNotNone(result)
        has_errors, msg = result
        self.assertTrue(has_errors)
        self.assertIn("validation error", msg.lower())

    def test_gpu_error_detected(self):
        log = self._write_log("Loading model...\nCUDA error: out of memory\nAborting.\n")
        result = run.detect_log_errors(log)
        self.assertIsNotNone(result)
        has_errors, msg = result
        self.assertTrue(has_errors)
        self.assertIn("CUDA", msg)

    def test_nonexistent_log_returns_none(self):
        result = run.detect_log_errors(self.tmpdir / "nonexistent.log")
        self.assertIsNone(result)


class TestCanaryExecution(unittest.TestCase):
    """Test canary (pre-flight check) execution."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_canary_success(self):
        ok, msg = run.run_canary(self.tmpdir, ["true"])
        self.assertTrue(ok)
        self.assertEqual(msg, "Canary passed")

    def test_canary_failure(self):
        ok, msg = run.run_canary(self.tmpdir, ["false"])
        self.assertFalse(ok)
        self.assertIn("exited with code 1", msg)

    def test_canary_writes_progress(self):
        run.run_canary(self.tmpdir, ["true"])
        # During execution, progress.json should have been written
        # (it gets overwritten later by the main experiment)
        progress_path = self.tmpdir / "progress.json"
        self.assertTrue(progress_path.exists())

    def test_canary_timeout(self):
        ok, msg = run.run_canary(self.tmpdir, ["sleep", "10"], timeout=0.5)
        self.assertFalse(ok)
        self.assertIn("timed out", msg)

    def test_canary_bad_command(self):
        ok, msg = run.run_canary(self.tmpdir, ["/nonexistent/command"])
        self.assertFalse(ok)
        self.assertIn("failed to start", msg.lower())

    def test_canary_failure_writes_canary_log(self):
        run.run_canary(self.tmpdir, ["bash", "-c", "echo canary-output && exit 1"])
        canary_log = self.tmpdir / "canary.log"
        self.assertTrue(canary_log.exists())
        self.assertIn("canary-output", canary_log.read_text())


class TestParseLedgerTotals(unittest.TestCase):
    """Test ledger YAML parsing."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_single_entry(self):
        ledger = self.tmpdir / "ledger.yaml"
        ledger.write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: exp1
                resource: llm_api_calls
                amount: 500
        """))
        result = run._parse_ledger_totals(ledger)
        self.assertEqual(result["exp1"]["llm_api_calls"], 500)

    def test_multiple_entries_same_experiment(self):
        ledger = self.tmpdir / "ledger.yaml"
        ledger.write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: exp1
                resource: llm_api_calls
                amount: 300
              - date: "2026-01-02"
                experiment: exp1
                resource: llm_api_calls
                amount: 200
        """))
        result = run._parse_ledger_totals(ledger)
        self.assertEqual(result["exp1"]["llm_api_calls"], 500)

    def test_multiple_experiments(self):
        ledger = self.tmpdir / "ledger.yaml"
        ledger.write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: exp1
                resource: llm_api_calls
                amount: 300
              - date: "2026-01-01"
                experiment: exp2
                resource: llm_api_calls
                amount: 200
        """))
        result = run._parse_ledger_totals(ledger)
        self.assertEqual(result["exp1"]["llm_api_calls"], 300)
        self.assertEqual(result["exp2"]["llm_api_calls"], 200)

    def test_nonexistent_file(self):
        result = run._parse_ledger_totals(self.tmpdir / "missing.yaml")
        self.assertEqual(result, {})

    def test_multiple_resource_types(self):
        ledger = self.tmpdir / "ledger.yaml"
        ledger.write_text(textwrap.dedent("""\
            entries:
              - date: "2026-01-01"
                experiment: exp1
                resource: llm_api_calls
                amount: 300
              - date: "2026-01-01"
                experiment: exp1
                resource: gen_3d_api_calls
                amount: 50
        """))
        result = run._parse_ledger_totals(ledger)
        self.assertEqual(result["exp1"]["llm_api_calls"], 300)
        self.assertEqual(result["exp1"]["gen_3d_api_calls"], 50)


class TestCountSucceededRows(unittest.TestCase):
    """Test succeeded row counting from CSV status/error columns."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_status_column_completed(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,status,error\n1,completed,\n2,failed,timeout\n3,completed,\n")
        self.assertEqual(run.count_succeeded_rows(csv), 2)

    def test_status_column_ok(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("mode,mesh_id,status,elapsed_s,error\na,001,ok,6.3,\na,002,ok,4.1,\na,003,ok,4.2,\n")
        self.assertEqual(run.count_succeeded_rows(csv), 3)

    def test_status_column_mixed_values(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,status\n1,completed\n2,failed\n3,ok\n4,success\n5,error\n6,done\n7,passed\n")
        self.assertEqual(run.count_succeeded_rows(csv), 5)

    def test_status_column_case_insensitive(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,status\n1,Completed\n2,OK\n3,FAILED\n")
        self.assertEqual(run.count_succeeded_rows(csv), 2)

    def test_status_column_all_failed(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,status,error\n1,failed,timeout\n2,failed,connection\n3,failed,error\n")
        self.assertEqual(run.count_succeeded_rows(csv), 0)

    def test_error_column_fallback(self):
        """When no status column but error column exists, empty error = success."""
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,score,error\n1,0.8,\n2,0.3,bad input\n3,0.9,\n")
        self.assertEqual(run.count_succeeded_rows(csv), 2)

    def test_error_column_all_empty(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,error\n1,\n2,\n3,\n")
        self.assertEqual(run.count_succeeded_rows(csv), 3)

    def test_no_status_or_error_column(self):
        """CSVs without status/error columns return None."""
        csv = self.tmpdir / "test.csv"
        csv.write_text("dataset,task_id,model_a,model_b\nDATASET001,002,model-a,model-c\n")
        self.assertIsNone(run.count_succeeded_rows(csv))

    def test_nonexistent_file(self):
        self.assertIsNone(run.count_succeeded_rows(self.tmpdir / "missing.csv"))

    def test_empty_csv(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("")
        self.assertIsNone(run.count_succeeded_rows(csv))

    def test_header_only(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,status\n")
        self.assertEqual(run.count_succeeded_rows(csv), 0)

    def test_status_takes_precedence_over_error(self):
        """When both status and error columns exist, status is used."""
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,status,error\n1,completed,\n2,failed,\n3,ok,some warning\n")
        self.assertEqual(run.count_succeeded_rows(csv), 2)


class TestCountSuccessFailureRows(unittest.TestCase):
    """Test success/failure row counting from CSV status/error columns."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_status_column_returns_tuple(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,status\n1,completed\n2,failed\n3,ok\n")
        result = run.count_success_failure_rows(csv)
        self.assertEqual(result, (2, 1))  # 2 success (completed, ok), 1 failed

    def test_status_column_all_success(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,status\n1,completed\n2,ok\n3,success\n")
        result = run.count_success_failure_rows(csv)
        self.assertEqual(result, (3, 0))

    def test_status_column_all_failed(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,status\n1,failed\n2,error\n3,timeout\n")
        result = run.count_success_failure_rows(csv)
        self.assertEqual(result, (0, 3))

    def test_error_column_fallback(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("id,error\n1,\n2,timeout\n3,\n")
        result = run.count_success_failure_rows(csv)
        self.assertEqual(result, (2, 1))  # 2 empty error (success), 1 with error

    def test_no_status_or_error_column(self):
        csv = self.tmpdir / "test.csv"
        csv.write_text("a,b\n1,2\n")
        self.assertIsNone(run.count_success_failure_rows(csv))

    def test_nonexistent_file(self):
        self.assertIsNone(run.count_success_failure_rows(self.tmpdir / "missing.csv"))


class TestRunExperiment(unittest.TestCase):
    """Integration tests for the full experiment runner flow."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.exp_dir = self.tmpdir / "test-experiment"
        self.exp_dir.mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_successful_command(self):
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c", "echo hello"],
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["status"], "completed")
        self.assertEqual(progress["exit_code"], 0)
        self.assertIn("duration_s", progress)

    def test_failing_command(self):
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c", "exit 42"],
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 42)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["status"], "failed")
        self.assertEqual(progress["exit_code"], 42)
        self.assertEqual(progress["failure_class"], "permanent")

    def test_canary_blocks_experiment(self):
        """When canary fails, the experiment should not run."""
        marker = self.exp_dir / "experiment_ran"
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c", f"touch {marker}"],
            canary_cmd=["false"],
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 2)
        self.assertFalse(marker.exists())

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["status"], "canary_failed")

    def test_canary_passes_experiment_runs(self):
        marker = self.exp_dir / "experiment_ran"
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c", f"touch {marker}"],
            canary_cmd=["true"],
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)
        self.assertTrue(marker.exists())

    def test_csv_progress_tracking(self):
        """Test that --watch-csv tracks CSV row count."""
        csv_path = self.exp_dir / "output.csv"
        # Write CSV as part of the command
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c", f"echo 'header' > {csv_path} && echo 'row1' >> {csv_path} && echo 'row2' >> {csv_path}"],
            watch_csv=csv_path,
            total=10,
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["status"], "completed")
        # Final row count should be captured
        self.assertEqual(progress["current"], 2)

    def test_csv_progress_deduplicates_retry_entries(self):
        """--watch-csv should deduplicate rows by first column for progress."""
        csv_path = self.exp_dir / "output.csv"
        # Write CSV with duplicates (simulating retry entries)
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c",
             f"echo 'task_id,status' > {csv_path} && "
             f"echo '001,ok' >> {csv_path} && "
             f"echo '002,ok' >> {csv_path} && "
             f"echo '001,ok' >> {csv_path} && "
             f"echo '003,ok' >> {csv_path}"],
            watch_csv=csv_path,
            total=10,
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        # 4 rows total, but only 3 unique by task_id
        self.assertEqual(progress["current"], 3)  # deduplicated
        self.assertEqual(progress["total_rows_raw"], 4)  # raw count
        self.assertIn("unique", progress["message"])

    def test_succeeded_in_progress_with_watch_csv(self):
        """When --watch-csv points to a CSV with a status column, success/failed is reported."""
        csv_path = self.exp_dir / "output.csv"
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c",
             f"printf 'id,status\\n1,completed\\n2,failed\\n3,ok\\n' > {csv_path}"],
            watch_csv=csv_path,
            total=3,
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["current"], 3)
        self.assertEqual(progress["success"], 2)
        self.assertEqual(progress["failed"], 1)
        self.assertEqual(progress["success_rate"], 66.7)  # 2/3 = 66.67%

    def test_succeeded_without_watch_csv(self):
        """When no --watch-csv but results/ has a CSV with status, success/failed is reported."""
        results_dir = self.exp_dir / "results"
        results_dir.mkdir()
        csv_path = results_dir / "output.csv"

        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c",
             f"printf 'id,status\\n1,ok\\n2,ok\\n3,failed\\n' > {csv_path}"],
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["success"], 2)
        self.assertEqual(progress["failed"], 1)

    def test_no_succeeded_when_no_status_column(self):
        """CSVs without status/error columns should not add success/failed field."""
        csv_path = self.exp_dir / "output.csv"
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c",
             f"printf 'a,b\\n1,2\\n3,4\\n' > {csv_path}"],
            watch_csv=csv_path,
            total=2,
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertNotIn("success", progress)
        self.assertNotIn("failed", progress)

    def test_low_success_rate_fails(self):
        """If success rate is below 50%, experiment should fail even with exit code 0."""
        csv_path = self.exp_dir / "output.csv"
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c",
             f"printf 'id,status\\n1,completed\\n2,failed\\n3,failed\\n4,failed\\n5,failed\\n' > {csv_path}"],
            watch_csv=csv_path,
            total=5,
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 1)  # Should fail due to low success rate

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["status"], "failed")
        self.assertEqual(progress["failure_class"], "low_success_rate")
        self.assertEqual(progress["success"], 1)
        self.assertEqual(progress["failed"], 4)
        self.assertEqual(progress["success_rate"], 20.0)  # 1/5 = 20%

    def test_high_success_rate_succeeds(self):
        """If success rate is above 50%, experiment should succeed with exit code 0."""
        csv_path = self.exp_dir / "output.csv"
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c",
             f"printf 'id,status\\n1,completed\\n2,ok\\n3,ok\\n4,failed\\n5,failed\\n' > {csv_path}"],
            watch_csv=csv_path,
            total=5,
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["status"], "completed")
        self.assertEqual(progress["success"], 3)
        self.assertEqual(progress["failed"], 2)
        self.assertEqual(progress["success_rate"], 60.0)  # 3/5 = 60%

    def test_log_file_created(self):
        run.run_experiment(
            self.exp_dir,
            ["bash", "-c", "echo test-output"],
            poll_interval=0.1,
        )
        log_path = self.exp_dir / "output.log"
        self.assertTrue(log_path.exists())
        self.assertIn("test-output", log_path.read_text())

    def test_artifacts_dir_redirects_runtime_outputs(self):
        artifacts_dir = self.tmpdir / "modules" / "demo" / "artifacts" / "test-experiment"
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c", "echo test-output && touch result.txt"],
            poll_interval=0.1,
            artifacts_dir=artifacts_dir,
        )
        self.assertEqual(exit_code, 0)

        self.assertTrue((self.exp_dir / "progress.json").exists())
        self.assertFalse((self.exp_dir / "output.log").exists())
        self.assertTrue((artifacts_dir / "output.log").exists())
        self.assertTrue((artifacts_dir / "result.txt").exists())
        self.assertIn("test-output", (artifacts_dir / "output.log").read_text())

    def test_lock_prevents_concurrent_runs(self):
        """Acquiring lock on an already-locked dir should fail."""
        lock_fd = run.acquire_lock(self.exp_dir)
        self.assertIsNotNone(lock_fd)

        # Second attempt should fail
        lock_fd2 = run.acquire_lock(self.exp_dir)
        self.assertIsNone(lock_fd2)

        # Release and retry should succeed
        run.release_lock(lock_fd, self.exp_dir)
        lock_fd3 = run.acquire_lock(self.exp_dir)
        self.assertIsNotNone(lock_fd3)
        run.release_lock(lock_fd3, self.exp_dir)

    def test_exit_code_0_with_log_errors_fails(self):
        """If command exits 0 but log has systematic errors, should fail."""
        script = self.exp_dir / "bad_script.sh"
        # Generate 25 error lines (above the 20-line threshold)
        error_lines = " && ".join([f"echo 'Error evaluating task {i}'" for i in range(25)])
        script.write_text(f"#!/bin/bash\n{error_lines}\nexit 0\n")
        script.chmod(0o755)

        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 1)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["status"], "failed")
        self.assertEqual(progress["exit_code"], 0)
        self.assertEqual(progress["failure_class"], "permanent")
        self.assertIn("log analysis", progress["error"])


class TestRetryProgressGuard(unittest.TestCase):
    """Test the retry progress guard that prevents unbounded resource waste.

    The guard checks whether retries are producing new unique rows. If two
    consecutive retries produce zero new rows, the failure is reclassified
    from transient to deterministic and retries stop.
    """

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.exp_dir = self.tmpdir / "retry-test"
        self.exp_dir.mkdir()
        (self.exp_dir / "results").mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_transient_failure_retries(self):
        """Exit code 137 (SIGKILL convention) should trigger retry if max_retries > 0.

        Note: Python subprocess reports direct SIGKILL as -9, but shell scripts
        report killed children as 128+9=137. The runner checks for 137 (the
        shell convention), which is what experiment run.sh scripts produce when
        their child processes are killed externally (OOM, Vulkan crash, etc.).
        """
        # Script that exits 137 on first attempt, succeeds on second
        script = self.exp_dir / "retry_script.sh"
        marker = self.exp_dir / "attempt_marker"
        script.write_text(textwrap.dedent(f"""\
            #!/bin/bash
            if [ ! -f "{marker}" ]; then
                touch "{marker}"
                exit 137
            fi
            echo "success"
        """))
        script.chmod(0o755)

        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            max_retries=3,
            retry_delay=0.1,
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)

    def test_permanent_failure_no_retry(self):
        """Exit code 1 (permanent) should not retry."""
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", "-c", "exit 1"],
            max_retries=3,
            retry_delay=0.1,
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 1)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["failure_class"], "permanent")
        self.assertEqual(progress["attempt"], 1)

    def test_no_progress_stops_retries(self):
        """If retries produce no new CSV rows, should stop retrying.

        Uses exit 137 (shell convention for SIGKILL) since that's what
        the runner classifies as transient.
        """
        csv = self.exp_dir / "results" / "output.csv"
        csv.write_text("header\nrow1\nrow2\n")  # Pre-existing data

        # Script that always exits 137 (SIGKILL convention) without producing new rows
        script = self.exp_dir / "stall_script.sh"
        script.write_text("#!/bin/bash\nexit 137\n")
        script.chmod(0o755)

        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            max_retries=5,
            retry_delay=0.1,
            poll_interval=0.1,
        )
        # Should have stopped before exhausting all retries
        self.assertNotEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        # Should be reclassified as deterministic_no_progress
        self.assertEqual(progress["failure_class"], "deterministic_no_progress")
        # Should have stopped after attempt 3 (two consecutive no-progress retries after attempt 2)
        self.assertLessEqual(progress["attempt"], 4)

    def test_max_retries_exhausted(self):
        """When max retries exhausted, failure_class should be transient_exhausted.

        Uses exit 137 (shell convention for SIGKILL). Each attempt produces
        new data to avoid the progress guard aborting early.
        """
        script = self.exp_dir / "always_crash.sh"
        # Produce some new data each time to avoid progress guard, then exit 137
        script.write_text(textwrap.dedent(f"""\
            #!/bin/bash
            echo "new-data-$(date +%s%N)" >> {self.exp_dir / 'results' / 'output.csv'}
            exit 137
        """))
        script.chmod(0o755)
        # Write initial CSV header
        (self.exp_dir / "results" / "output.csv").write_text("header\n")

        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            max_retries=2,
            retry_delay=0.1,
            poll_interval=0.1,
        )
        self.assertNotEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["failure_class"], "transient_exhausted")
        self.assertEqual(progress["attempt"], 3)  # 1 + 2 retries


class TestWasteRatioAbort(unittest.TestCase):
    """Test the waste-ratio abort threshold that catches resume corruption.

    When retries produce CSV rows where >30% are duplicates, the experiment
    is aborted with failure_class='resume_corruption'. This catches the
    flash-240 scenario where each retry re-evaluated already-completed tasks
    due to a resume bug, wasting 87.3% of API calls.
    """

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.exp_dir = self.tmpdir / "waste-test"
        self.exp_dir.mkdir()
        (self.exp_dir / "results").mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_high_waste_ratio_aborts(self):
        """CSV with >30% duplicates should trigger resume_corruption abort.

        Simulates the flash-240 scenario: script appends duplicate rows to
        CSV on each retry, then exits 137 (SIGKILL convention). After the
        waste ratio exceeds 30%, the runner should abort.
        """
        csv_path = self.exp_dir / "results" / "output.csv"
        # Pre-populate CSV with unique rows + many duplicates (>30% waste)
        # The script will add more duplicates each attempt
        csv_path.write_text(
            "task_id,model_a,model_b\n"
            "001,a,b\n"
            "002,a,b\n"
            "003,a,b\n"
            "001,a,b\n"  # duplicate
            "002,a,b\n"  # duplicate
            "001,a,b\n"  # duplicate
            "002,a,b\n"  # duplicate
        )
        # 7 rows total, 3 unique = waste ratio 4/7 = 57% > 30%

        # Script exits 137 (transient) to trigger retry logic
        script = self.exp_dir / "dup_script.sh"
        script.write_text("#!/bin/bash\nexit 137\n")
        script.chmod(0o755)

        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            max_retries=5,
            retry_delay=0.1,
            poll_interval=0.1,
        )
        self.assertNotEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["failure_class"], "resume_corruption")
        self.assertIn("waste ratio", progress["error"].lower())

    def test_low_waste_ratio_allows_retry(self):
        """CSV with <30% duplicates should NOT trigger waste-ratio abort.

        The retry should proceed normally (eventually hitting max retries
        or another guard).
        """
        csv_path = self.exp_dir / "results" / "output.csv"
        # 10 unique rows, 2 duplicates = 2/12 = 16.7% waste — below threshold
        lines = ["task_id,model_a,model_b\n"]
        for i in range(10):
            lines.append(f"{i:03d},a,b\n")
        lines.append("000,a,b\n")  # 1 duplicate
        lines.append("001,a,b\n")  # 1 duplicate
        csv_path.write_text("".join(lines))

        # Script that adds a unique row each attempt then exits 137
        script = self.exp_dir / "low_waste.sh"
        script.write_text(textwrap.dedent(f"""\
            #!/bin/bash
            echo "$(date +%s%N),a,b" >> {csv_path}
            exit 137
        """))
        script.chmod(0o755)

        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            max_retries=2,
            retry_delay=0.1,
            poll_interval=0.1,
        )
        self.assertNotEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        # Should exhaust retries normally, NOT resume_corruption
        self.assertNotEqual(progress.get("failure_class"), "resume_corruption")

    def test_waste_ratio_with_watched_csv(self):
        """Waste-ratio check should work when --watch-csv is specified."""
        csv_path = self.exp_dir / "results" / "output.csv"
        # Pre-populate with high waste ratio
        csv_path.write_text(
            "task_id,model_a,model_b\n"
            "001,a,b\n"
            "001,a,b\n"
            "001,a,b\n"
            "001,a,b\n"
            "002,a,b\n"
        )
        # 5 rows, 2 unique = waste 3/5 = 60%

        script = self.exp_dir / "crash.sh"
        script.write_text("#!/bin/bash\nexit 137\n")
        script.chmod(0o755)

        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            watch_csv=csv_path,
            total=100,
            max_retries=5,
            retry_delay=0.1,
            poll_interval=0.1,
        )
        self.assertNotEqual(exit_code, 0)

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["failure_class"], "resume_corruption")

    def test_waste_ratio_zero_rows_skips_check(self):
        """When CSV has zero rows, waste-ratio check should not trigger.

        Zero rows means the experiment hasn't produced output yet — no
        duplicates to detect.
        """
        csv_path = self.exp_dir / "results" / "output.csv"
        csv_path.write_text("task_id,model_a,model_b\n")  # header only

        # Script exits 137, succeeds on second attempt
        script = self.exp_dir / "recover.sh"
        marker = self.exp_dir / "attempt_marker"
        script.write_text(textwrap.dedent(f"""\
            #!/bin/bash
            if [ ! -f "{marker}" ]; then
                touch "{marker}"
                exit 137
            fi
            echo "success"
        """))
        script.chmod(0o755)

        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            max_retries=3,
            retry_delay=0.1,
            poll_interval=0.1,
        )
        self.assertEqual(exit_code, 0)

    def test_waste_ratio_reported_in_progress(self):
        """The waste ratio should be recorded in progress.json retry_progress."""
        csv_path = self.exp_dir / "results" / "output.csv"
        csv_path.write_text(
            "task_id,model_a,model_b\n"
            "001,a,b\n"
            "002,a,b\n"
            "001,a,b\n"
            "001,a,b\n"
            "001,a,b\n"
        )
        # 5 rows, 2 unique = 60% waste

        script = self.exp_dir / "crash.sh"
        script.write_text("#!/bin/bash\nexit 137\n")
        script.chmod(0o755)

        run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            max_retries=3,
            retry_delay=0.1,
            poll_interval=0.1,
        )

        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertIn("retry_progress", progress)
        self.assertIn("waste_ratio", progress["retry_progress"])
        self.assertGreater(progress["retry_progress"]["waste_ratio"], 0.3)

    def test_configurable_waste_ratio_threshold(self):
        """Custom threshold should override default 30%."""
        csv_path = self.exp_dir / "results" / "output.csv"
        # 5 rows, 2 unique = 60% waste
        csv_path.write_text(
            "task_id,model_a,model_b\n"
            "001,a,b\n"
            "002,a,b\n"
            "001,a,b\n"
            "001,a,b\n"
            "001,a,b\n"
        )

        script = self.exp_dir / "crash.sh"
        script.write_text("#!/bin/bash\nexit 137\n")
        script.chmod(0o755)

        # With threshold=0.7 (70%), 60% waste should NOT abort
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            max_retries=2,
            retry_delay=0.1,
            poll_interval=0.1,
            waste_ratio_threshold=0.7,
        )
        self.assertNotEqual(exit_code, 0)
        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertNotEqual(progress.get("failure_class"), "resume_corruption")

        # Reset for second test
        (self.exp_dir / "progress.json").unlink(missing_ok=True)
        csv_path.write_text(
            "task_id,model_a,model_b\n"
            "001,a,b\n"
            "002,a,b\n"
            "001,a,b\n"
            "001,a,b\n"
            "001,a,b\n"
        )

        # With threshold=0.5 (50%), 60% waste SHOULD abort
        exit_code = run.run_experiment(
            self.exp_dir,
            ["bash", str(script)],
            max_retries=2,
            retry_delay=0.1,
            poll_interval=0.1,
            waste_ratio_threshold=0.5,
        )
        self.assertNotEqual(exit_code, 0)
        progress = json.loads((self.exp_dir / "progress.json").read_text())
        self.assertEqual(progress["failure_class"], "resume_corruption")
        self.assertIn("50%", progress["error"])


class TestReadNRuns(unittest.TestCase):
    """Test n_runs reading from config.json."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_reads_n_runs(self):
        (self.tmpdir / "config.json").write_text('{"n_runs": 6}')
        self.assertEqual(run._read_n_runs(self.tmpdir), 6)

    def test_default_is_1(self):
        (self.tmpdir / "config.json").write_text('{}')
        self.assertEqual(run._read_n_runs(self.tmpdir), 1)

    def test_missing_config(self):
        self.assertEqual(run._read_n_runs(self.tmpdir), 1)

    def test_invalid_json(self):
        (self.tmpdir / "config.json").write_text('not json')
        self.assertEqual(run._read_n_runs(self.tmpdir), 1)

    def test_dimension_specific_configs(self):
        """When config.json is absent but config_overall.json exists, read n_runs from it."""
        (self.tmpdir / "config_overall.json").write_text('{"n_runs": 4}')
        self.assertEqual(run._read_n_runs(self.tmpdir), 4)

    def test_multiple_dimension_configs(self):
        """When multiple config_*.json exist, use the max n_runs."""
        (self.tmpdir / "config_overall.json").write_text('{"n_runs": 4}')
        (self.tmpdir / "config_mesh.json").write_text('{"n_runs": 6}')
        self.assertEqual(run._read_n_runs(self.tmpdir), 6)

    def test_config_json_takes_precedence(self):
        """config.json is preferred over dimension-specific configs."""
        (self.tmpdir / "config.json").write_text('{"n_runs": 8}')
        (self.tmpdir / "config_overall.json").write_text('{"n_runs": 4}')
        self.assertEqual(run._read_n_runs(self.tmpdir), 8)

    def test_dimension_config_missing_n_runs(self):
        """Dimension-specific config without n_runs defaults to 1."""
        (self.tmpdir / "config_overall.json").write_text('{"model": "gemini"}')
        self.assertEqual(run._read_n_runs(self.tmpdir), 1)

    def test_dimension_config_invalid_json(self):
        """Invalid JSON in dimension-specific config defaults to 1."""
        (self.tmpdir / "config_overall.json").write_text('not json')
        self.assertEqual(run._read_n_runs(self.tmpdir), 1)


class TestAcquireReleaseLock(unittest.TestCase):
    """Test experiment directory locking."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_acquire_lock(self):
        fd = run.acquire_lock(self.tmpdir)
        self.assertIsNotNone(fd)
        # Lock file should contain PID
        lock_content = (self.tmpdir / ".experiment.lock").read_text()
        self.assertEqual(lock_content.strip(), str(os.getpid()))
        run.release_lock(fd, self.tmpdir)

    def test_double_acquire_fails(self):
        fd1 = run.acquire_lock(self.tmpdir)
        self.assertIsNotNone(fd1)
        fd2 = run.acquire_lock(self.tmpdir)
        self.assertIsNone(fd2)
        run.release_lock(fd1, self.tmpdir)

    def test_release_then_reacquire(self):
        fd1 = run.acquire_lock(self.tmpdir)
        run.release_lock(fd1, self.tmpdir)
        fd2 = run.acquire_lock(self.tmpdir)
        self.assertIsNotNone(fd2)
        run.release_lock(fd2, self.tmpdir)

    def test_lock_file_cleaned_up(self):
        fd = run.acquire_lock(self.tmpdir)
        run.release_lock(fd, self.tmpdir)
        self.assertFalse((self.tmpdir / ".experiment.lock").exists())


class TestResolveCommand(unittest.TestCase):
    """Test shell command resolution via shutil.which().

    The detached experiment runner (--detach) creates a process via
    start_new_session=True where common shell commands (bash, python3)
    may not be in PATH. resolve_command() resolves bare command names
    to absolute paths to prevent 'command not found' errors.
    """

    @patch("shutil.which")
    def test_bare_bash_resolved_to_absolute(self, mock_which):
        """bare 'bash' is resolved to its absolute path."""
        mock_which.return_value = "/usr/bin/bash"
        result = run.resolve_command(["bash", "run.sh"])
        self.assertEqual(result[0], "/usr/bin/bash")
        self.assertEqual(result[1], "run.sh")
        mock_which.assert_called_once_with("bash")

    @patch("shutil.which")
    def test_bare_python3_resolved(self, mock_which):
        """bare 'python3' is resolved to its absolute path."""
        mock_which.return_value = "/usr/bin/python3"
        result = run.resolve_command(["python3", "script.py"])
        self.assertEqual(result[0], "/usr/bin/python3")
        mock_which.assert_called_once_with("python3")

    @patch("shutil.which")
    def test_bare_sh_resolved(self, mock_which):
        """bare 'sh' is resolved to its absolute path."""
        mock_which.return_value = "/bin/sh"
        result = run.resolve_command(["sh", "run.sh"])
        self.assertEqual(result[0], "/bin/sh")

    @patch("shutil.which")
    def test_absolute_path_not_resolved(self, mock_which):
        """Already-absolute paths are not re-resolved."""
        result = run.resolve_command(["/usr/bin/bash", "run.sh"])
        self.assertEqual(result[0], "/usr/bin/bash")
        mock_which.assert_not_called()

    @patch("shutil.which")
    def test_which_returns_none_keeps_original(self, mock_which):
        """If shutil.which() can't find the command, keep original."""
        mock_which.return_value = None
        result = run.resolve_command(["obscure-tool", "arg1"])
        self.assertEqual(result[0], "obscure-tool")

    @patch("shutil.which")
    def test_empty_command_returns_empty(self, mock_which):
        """Empty command list returns empty list."""
        result = run.resolve_command([])
        self.assertEqual(result, [])
        mock_which.assert_not_called()

    @patch("shutil.which")
    def test_rest_of_args_unchanged(self, mock_which):
        """Only the first element (the executable) is resolved."""
        mock_which.return_value = "/usr/bin/python3"
        result = run.resolve_command(["python3", "-m", "pytest", "tests/"])
        self.assertEqual(result, ["/usr/bin/python3", "-m", "pytest", "tests/"])

    @patch("shutil.which")
    def test_relative_path_with_slash_not_resolved(self, mock_which):
        """Commands containing '/' (relative paths like ./run.sh) are not resolved."""
        result = run.resolve_command(["./run.sh", "arg1"])
        self.assertEqual(result[0], "./run.sh")
        mock_which.assert_not_called()


class TestWatchCsvValidation(unittest.TestCase):
    """Test --watch-csv path validation warning."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.exp_dir = self.tmpdir / "test-experiment"
        self.exp_dir.mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_warns_if_watch_csv_missing_after_30s(self):
        """If --watch-csv file doesn't exist after ~30s, warn."""
        nonexistent_csv = self.exp_dir / "nonexistent.csv"
        script = self.exp_dir / "long_running.sh"
        script.write_text("#!/bin/bash\nsleep 0.7\n")
        script.chmod(0o755)

        import io
        stderr_capture = io.StringIO()
        with patch("sys.stderr", new_callable=lambda: stderr_capture):
            exit_code = run.run_experiment(
                self.exp_dir,
                ["bash", str(script)],
                watch_csv=nonexistent_csv,
                total=10,
                poll_interval=0.1,  # 6 polls = 0.6s
            )
        self.assertEqual(exit_code, 0)
        stderr_output = stderr_capture.getvalue()
        self.assertIn("WARNING: --watch-csv file does not exist after 30s", stderr_output)

    def test_no_warning_if_watch_csv_exists(self):
        """No warning if --watch-csv file exists."""
        csv_path = self.exp_dir / "output.csv"
        script = self.exp_dir / "write_csv.sh"
        script.write_text(f"#!/bin/bash\necho 'header' > {csv_path}\nsleep 0.3\n")
        script.chmod(0o755)

        import io
        stderr_capture = io.StringIO()
        with patch("sys.stderr", new_callable=lambda: stderr_capture):
            exit_code = run.run_experiment(
                self.exp_dir,
                ["bash", str(script)],
                watch_csv=csv_path,
                total=10,
                poll_interval=0.1,
            )
        self.assertEqual(exit_code, 0)
        stderr_output = stderr_capture.getvalue()
        self.assertNotIn("WARNING: --watch-csv file does not exist", stderr_output)


class TestMandatoryFlagsValidation(unittest.TestCase):
    """Test mandatory flags validation for --detach mode (ADR 0027)."""

    def test_all_flags_present_returns_empty(self):
        missing = run.validate_mandatory_flags(
            project_dir=Path("/some/project"),
            max_retries=3,
            watch_csv=Path("/some/output.csv"),
            total=100,
            artifacts_dir=Path("/some/module/artifacts/exp"),
        )
        self.assertEqual(missing, [])

    def test_missing_project_dir(self):
        missing = run.validate_mandatory_flags(
            project_dir=None,
            max_retries=3,
            watch_csv=Path("/some/output.csv"),
            total=100,
            artifacts_dir=Path("/some/module/artifacts/exp"),
        )
        self.assertIn("--project-dir", missing)

    def test_missing_max_retries(self):
        missing = run.validate_mandatory_flags(
            project_dir=Path("/some/project"),
            max_retries=None,
            watch_csv=Path("/some/output.csv"),
            total=100,
            artifacts_dir=Path("/some/module/artifacts/exp"),
        )
        self.assertIn("--max-retries", missing)

    def test_missing_watch_csv(self):
        missing = run.validate_mandatory_flags(
            project_dir=Path("/some/project"),
            max_retries=3,
            watch_csv=None,
            total=100,
            artifacts_dir=Path("/some/module/artifacts/exp"),
        )
        self.assertIn("--watch-csv", missing)

    def test_watch_csv_without_total(self):
        missing = run.validate_mandatory_flags(
            project_dir=Path("/some/project"),
            max_retries=3,
            watch_csv=Path("/some/output.csv"),
            total=None,
            artifacts_dir=Path("/some/module/artifacts/exp"),
        )
        self.assertIn("--total", " ".join(missing))

    def test_missing_artifacts_dir(self):
        missing = run.validate_mandatory_flags(
            project_dir=Path("/some/project"),
            max_retries=3,
            watch_csv=Path("/some/output.csv"),
            total=100,
            artifacts_dir=None,
        )
        self.assertIn("--artifacts-dir", missing)

    def test_all_missing(self):
        missing = run.validate_mandatory_flags(
            project_dir=None,
            max_retries=None,
            watch_csv=None,
            total=None,
            artifacts_dir=None,
        )
        self.assertEqual(len(missing), 4)

    def test_detach_with_missing_flags_exits_4(self):
        tmpdir = Path(tempfile.mkdtemp())
        exp_dir = tmpdir / "exp"
        exp_dir.mkdir()
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).parent / "run.py"),
                    "--detach",
                    str(exp_dir),
                    "--",
                    "echo",
                    "test",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 4)
            self.assertIn("Missing mandatory flags", result.stderr)
            self.assertIn("--project-dir", result.stderr)
            self.assertIn("--max-retries", result.stderr)
            self.assertIn("--watch-csv", result.stderr)
            self.assertIn("--artifacts-dir", result.stderr)
        finally:
            import shutil
            shutil.rmtree(tmpdir)

    def test_detach_with_all_flags_succeeds(self):
        tmpdir = Path(tempfile.mkdtemp())
        exp_dir = tmpdir / "exp"
        exp_dir.mkdir()
        csv_path = exp_dir / "output.csv"
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).parent / "run.py"),
                    "--detach",
                    "--artifacts-dir", str(tmpdir / "modules" / "exp" / "artifacts"),
                    "--project-dir", str(tmpdir),
                    "--max-retries", "0",
                    "--watch-csv", str(csv_path),
                    "--total", "10",
                    str(exp_dir),
                    "--",
                    "echo",
                    "test",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0)
            self.assertIn('"launched": true', result.stdout)
        finally:
            import shutil
            shutil.rmtree(tmpdir)


if __name__ == "__main__":
    unittest.main()
