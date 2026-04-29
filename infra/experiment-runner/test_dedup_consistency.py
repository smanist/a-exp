"""
Audit: Deduplication consistency across experiment-runner functions.

Tests three dedup functions on representative CSV schemas:
1. read_unique_csv_rows - key-column dedup via pandas (progress tracking)
2. _count_unique_csv_rows - key-column dedup via pandas (consumption audit)
3. _count_unique_csv_rows_simple - whole-line dedup (pandas fallback)

After fix: read_unique_csv_rows delegates to _count_unique_csv_rows for key-column dedup.
Both use the same key columns (task_id, image_id, dataset, model_a, model_b, render_type, question_key).

Run: python -m pytest infra/experiment-runner/test_dedup_consistency.py -v
"""

import unittest
import tempfile
from pathlib import Path
import run


class TestDedupConsistencyAudit(unittest.TestCase):
    """Audit dedup behavior across all three functions on representative CSV schemas."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_schema_1_task_id_first(self):
        """Schema: task_id as first column (primary key)."""
        csv = self.tmpdir / "task_id_first.csv"
        csv.write_text("task_id,result\n001,pass\n002,fail\n001,pass\n")

        read_unique = run.read_unique_csv_rows(csv)
        count_unique = run._count_unique_csv_rows(csv)
        count_simple = run._count_unique_csv_rows_simple(csv)

        # Both read_unique and count_unique use key-column dedup on task_id
        self.assertEqual(read_unique, 2, "read_unique_csv_rows: key-column dedup on task_id")
        self.assertEqual(count_unique, 2, "_count_unique_csv_rows: key-column dedup on task_id")
        self.assertEqual(count_simple, 2, "_count_unique_csv_rows_simple: whole-line dedup")
        # All three should be consistent now
        self.assertEqual(read_unique, count_unique, "read_unique and count_unique should match")

    def test_schema_2_run_id_first(self):
        """Schema: run_id as first column (NOT a primary key, but task_id is present)."""
        csv = self.tmpdir / "run_id_first.csv"
        csv.write_text(
            "run_id,task_id,judge_model\n"
            "1,orient-1,gpt-5.2\n"
            "1,orient-1,opus-4.6\n"
            "1,orient-2,gpt-5.2\n"
            "2,orient-1,gpt-5.2\n"
        )

        read_unique = run.read_unique_csv_rows(csv)
        count_unique = run._count_unique_csv_rows(csv)
        count_simple = run._count_unique_csv_rows_simple(csv)

        # read_unique and count_unique use key-column dedup on task_id -> 2 unique task_ids
        self.assertEqual(read_unique, 2, "read_unique_csv_rows: key-column dedup on task_id counts 2 unique tasks")
        self.assertEqual(count_unique, 2, "_count_unique_csv_rows: key-column dedup on task_id counts 2 unique tasks")
        self.assertEqual(count_simple, 4, "_count_unique_csv_rows_simple: whole-line dedup counts 4 distinct rows")
        # read_unique and count_unique should match (both use key-column dedup)
        self.assertEqual(read_unique, count_unique, "read_unique and count_unique should match")

    def test_schema_3_multi_column_with_keys(self):
        """Schema: CSV with key columns (dataset, task_id, model_a, model_b, render_type, question_key)."""
        csv = self.tmpdir / "multi_column_keys.csv"
        csv.write_text(
            "dataset,task_id,model_a,model_b,render_type,question_key,score\n"
            "bench-project,eval-001,gpt-5.2,opus-4.6,standard,q1,0.8\n"
            "bench-project,eval-001,gpt-5.2,opus-4.6,standard,q1,0.9\n"
            "bench-project,eval-001,gpt-5.2,opus-4.6,standard,q2,0.7\n"
            "bench-project,eval-002,gpt-5.2,opus-4.6,standard,q1,0.8\n"
        )

        read_unique = run.read_unique_csv_rows(csv)
        count_unique = run._count_unique_csv_rows(csv)
        count_simple = run._count_unique_csv_rows_simple(csv)

        # Both use key-column dedup -> (eval-001,q1) appears twice, deduped to 3 unique
        self.assertEqual(read_unique, 3, "read_unique_csv_rows: key-column dedup sees (eval-001,q1) twice, dedupes to 3")
        self.assertEqual(count_unique, 3, "_count_unique_csv_rows: key-column dedup sees (eval-001,q1) twice, dedupes to 3")
        self.assertEqual(count_simple, 4, "_count_unique_csv_rows_simple: whole-line dedup counts 4 distinct rows (q1 has 2 different scores)")
        self.assertEqual(read_unique, count_unique, "read_unique and count_unique should match")

    def test_schema_4_key_cols_partial_match(self):
        """Schema: CSV with SOME key columns (task_id only, not all 7)."""
        csv = self.tmpdir / "partial_keys.csv"
        csv.write_text(
            "run_id,task_id,output\n"
            "1,task-a,result1\n"
            "1,task-a,result2\n"
            "2,task-a,result1\n"
        )

        read_unique = run.read_unique_csv_rows(csv)
        count_unique = run._count_unique_csv_rows(csv)
        count_simple = run._count_unique_csv_rows_simple(csv)

        # Both use key-column dedup on task_id -> only 1 unique task_id (task-a)
        self.assertEqual(read_unique, 1, "read_unique_csv_rows: key-column dedup on task_id counts 1 unique task")
        self.assertEqual(count_unique, 1, "_count_unique_csv_rows: key-column dedup on task_id counts 1 unique task")
        self.assertEqual(count_simple, 3, "_count_unique_csv_rows_simple: whole-line dedup counts 3 distinct rows")
        self.assertEqual(read_unique, count_unique, "read_unique and count_unique should match")

    def test_schema_5_image_id_dedup(self):
        """Schema: image_id column (style-project case) with retry rows.

        This is the specific case that motivated the fix: retry entries for the same
        image_id should count as 1 unique image, not multiple.
        """
        csv = self.tmpdir / "image_id_retry.csv"
        csv.write_text(
            "image_id,filename,status,elapsed_s,error\n"
            "001,001.glb,success,100.0,\n"
            "002,002.glb,error,50.0,timeout\n"
            "002,002.glb,success,120.0,\n"
            "003,003.glb,success,95.0,\n"
        )

        read_unique = run.read_unique_csv_rows(csv)
        count_unique = run._count_unique_csv_rows(csv)
        count_simple = run._count_unique_csv_rows_simple(csv)

        # image_id is a key column -> 3 unique images (001, 002, 003)
        # Row 002 appears twice (first error, then success) but should count as 1
        self.assertEqual(read_unique, 3, "read_unique_csv_rows: key-column dedup on image_id counts 3 unique images")
        self.assertEqual(count_unique, 3, "_count_unique_csv_rows: key-column dedup on image_id counts 3 unique images")
        # Whole-line dedup would see 4 distinct rows (002 error != 002 success)
        self.assertEqual(count_simple, 4, "_count_unique_csv_rows_simple: whole-line dedup counts 4 distinct rows")
        self.assertEqual(read_unique, count_unique, "read_unique and count_unique should match")


    def test_consistency_matrix(self):
        """Summary test: verifies read_unique and count_unique are now consistent."""
        results = {}

        csv_task_id = self.tmpdir / "task_id.csv"
        csv_task_id.write_text("task_id,value\n001,a\n002,b\n001,a\n")
        results["task_id_first"] = {
            "read_unique": run.read_unique_csv_rows(csv_task_id),
            "count_unique": run._count_unique_csv_rows(csv_task_id),
            "count_simple": run._count_unique_csv_rows_simple(csv_task_id),
        }

        csv_run_id = self.tmpdir / "run_id.csv"
        csv_run_id.write_text("run_id,task_id,model\n1,t1,m1\n1,t1,m2\n2,t1,m1\n")
        results["run_id_first"] = {
            "read_unique": run.read_unique_csv_rows(csv_run_id),
            "count_unique": run._count_unique_csv_rows(csv_run_id),
            "count_simple": run._count_unique_csv_rows_simple(csv_run_id),
        }

        csv_keys = self.tmpdir / "with_keys.csv"
        csv_keys.write_text(
            "dataset,task_id,model_a,model_b,render_type,question_key,score\n"
            "d1,t1,m1,m2,std,q1,0.8\n"
            "d1,t1,m1,m2,std,q1,0.9\n"
            "d1,t1,m1,m2,std,q2,0.7\n"
        )
        results["multi_column_keys"] = {
            "read_unique": run.read_unique_csv_rows(csv_keys),
            "count_unique": run._count_unique_csv_rows(csv_keys),
            "count_simple": run._count_unique_csv_rows_simple(csv_keys),
        }

        print("\n" + "=" * 70)
        print("DEDUP CONSISTENCY AUDIT RESULTS")
        print("=" * 70)
        for schema, counts in results.items():
            key_dedup_consistent = counts["read_unique"] == counts["count_unique"]
            status = "CONSISTENT (key-dedup)" if key_dedup_consistent else "INCONSISTENT"
            print(f"\n{schema}:")
            print(f"  read_unique_csv_rows:      {counts['read_unique']}")
            print(f"  _count_unique_csv_rows:    {counts['count_unique']}")
            print(f"  _count_unique_csv_rows_simple: {counts['count_simple']}")
            print(f"  Status: {status}")

        print("\n" + "=" * 70)
        print("ANALYSIS:")
        print("  - read_unique_csv_rows and _count_unique_csv_rows now use same key-column dedup")
        print("  - They should ALWAYS be consistent")
        print("  - _count_unique_csv_rows_simple does whole-line dedup (fallback, differs when keys exist)")
        print("=" * 70)

        # Key assertion: read_unique and count_unique should always match now
        self.assertEqual(
            results["task_id_first"]["read_unique"],
            results["task_id_first"]["count_unique"],
            "read_unique and count_unique should always match (key-column dedup)"
        )
        self.assertEqual(
            results["run_id_first"]["read_unique"],
            results["run_id_first"]["count_unique"],
            "read_unique and count_unique should always match (key-column dedup)"
        )
        self.assertEqual(
            results["multi_column_keys"]["read_unique"],
            results["multi_column_keys"]["count_unique"],
            "read_unique and count_unique should always match (key-column dedup)"
        )

        # count_simple does whole-line dedup, differs when key columns exist
        self.assertNotEqual(
            results["multi_column_keys"]["read_unique"],
            results["multi_column_keys"]["count_simple"],
            "count_simple (whole-line) differs from key-column dedup when keys exist"
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
