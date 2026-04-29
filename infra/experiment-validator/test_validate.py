"""Tests for experiment validation: consumes_resources, literature citation verification,
spot-check validators for CSV row counts and config values.

TDD: tests written before implementation per AGENTS.md conventions.
"""

import tempfile
from pathlib import Path

import pytest

from validate import (
    parse_frontmatter,
    validate_experiment,
    validate_literature_citations,
    find_experiments,
    find_budget_dirs,
    validate_cross_references,
    validate_stale_approval_tags,
    _in_skip_dir,
)


def _make_experiment(tmp_path: Path, frontmatter: str, body: str) -> Path:
    """Create a minimal experiment directory with EXPERIMENT.md."""
    exp_dir = tmp_path / "test-exp"
    exp_dir.mkdir()
    (exp_dir / "EXPERIMENT.md").write_text(f"---\n{frontmatter}\n---\n{body}")
    return exp_dir


# ── consumes_resources field is required ──────────────────────────────────


class TestConsumesResourcesRequired:
    """consumes_resources must be present in frontmatter."""

    def test_missing_consumes_resources_is_error(self, tmp_path):
        fm = "id: test-exp\nstatus: planned\ndate: 2026-02-17\nproject: test\ntype: experiment"
        body = "\n## Design\n\nSome design.\n\n## Config\n\nSome config.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert any("consumes_resources" in m for m in error_msgs), (
            f"Expected error about missing consumes_resources, got: {error_msgs}"
        )

    def test_present_consumes_resources_no_error(self, tmp_path):
        fm = "id: test-exp\nstatus: planned\ndate: 2026-02-17\nproject: test\ntype: experiment\nconsumes_resources: true"
        body = "\n## Design\n\nSome design.\n\n## Config\n\nSome config.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert not any("consumes_resources" in m for m in error_msgs), (
            f"Unexpected consumes_resources error: {error_msgs}"
        )


# ── type=analysis allows either consumes_resources value ──────────────────


class TestAnalysisConsumesResourcesFlexible:
    """Analysis-type records allow either consumes_resources value (resource-signal checklist decides)."""

    def test_analysis_with_consumes_true_no_error(self, tmp_path):
        """Analysis tasks that consume resources (e.g., LLM-powered summarization) are valid."""
        fm = "id: test-exp\nstatus: completed\ndate: 2026-02-17\nproject: test\ntype: analysis\nconsumes_resources: true"
        body = "\n## Question\n\nSome question.\n\n## Method\n\nSome method.\n\n## Findings\n\nSome findings.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert not any("consumes_resources" in m for m in error_msgs), (
            f"Unexpected consumes_resources error for analysis+true: {error_msgs}"
        )

    def test_analysis_with_consumes_false_no_error(self, tmp_path):
        fm = "id: test-exp\nstatus: completed\ndate: 2026-02-17\nproject: test\ntype: analysis\nconsumes_resources: false"
        body = "\n## Question\n\nSome question.\n\n## Method\n\nSome method.\n\n## Findings\n\nSome findings.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert not any("consumes_resources" in m for m in error_msgs), (
            f"Unexpected consumes_resources error: {error_msgs}"
        )


# ── type=experiment must have consumes_resources=true ─────────────────────


class TestExperimentMustConsumeResources:
    """Experiment-type records must have consumes_resources: true."""

    def test_experiment_with_consumes_false_is_error(self, tmp_path):
        fm = "id: test-exp\nstatus: planned\ndate: 2026-02-17\nproject: test\ntype: experiment\nconsumes_resources: false"
        body = "\n## Design\n\nSome design.\n\n## Config\n\nSome config.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert any("experiment" in m and "consumes_resources" in m for m in error_msgs), (
            f"Expected error about experiment + consumes_resources=false, got: {error_msgs}"
        )

    def test_experiment_with_consumes_true_no_error(self, tmp_path):
        fm = "id: test-exp\nstatus: planned\ndate: 2026-02-17\nproject: test\ntype: experiment\nconsumes_resources: true"
        body = "\n## Design\n\nSome design.\n\n## Config\n\nSome config.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert not any("consumes_resources" in m for m in error_msgs), (
            f"Unexpected consumes_resources error: {error_msgs}"
        )


# ── type=implementation and type=bugfix allow either value ────────────────


class TestOtherTypesAllowEither:
    """Implementation and bugfix types allow either true or false."""

    def test_implementation_with_consumes_true_no_error(self, tmp_path):
        fm = "id: test-exp\nstatus: planned\ndate: 2026-02-17\nproject: test\ntype: implementation\nconsumes_resources: true"
        body = "\n## Specification\n\nSome spec.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert not any("consumes_resources" in m for m in error_msgs)

    def test_implementation_with_consumes_false_no_error(self, tmp_path):
        fm = "id: test-exp\nstatus: planned\ndate: 2026-02-17\nproject: test\ntype: implementation\nconsumes_resources: false"
        body = "\n## Specification\n\nSome spec.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert not any("consumes_resources" in m for m in error_msgs)

    def test_bugfix_with_consumes_false_no_error(self, tmp_path):
        fm = "id: test-exp\nstatus: planned\ndate: 2026-02-17\nproject: test\ntype: bugfix\nconsumes_resources: false"
        body = "\n## Problem\n\nSome problem.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert not any("consumes_resources" in m for m in error_msgs)


# ── Boolean parsing ───────────────────────────────────────────────────────


class TestConsumesResourcesParsing:
    """consumes_resources must be a valid boolean value."""

    def test_invalid_value_is_error(self, tmp_path):
        fm = "id: test-exp\nstatus: planned\ndate: 2026-02-17\nproject: test\ntype: experiment\nconsumes_resources: maybe"
        body = "\n## Design\n\nSome design.\n\n## Config\n\nSome config.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        error_msgs = [i.message for i in issues if i.level == "error"]
        assert any("consumes_resources" in m for m in error_msgs), (
            f"Expected error about invalid consumes_resources value, got: {error_msgs}"
        )


# ── Model/backend provenance (ADR 0043) ──────────────────────────────────


class TestModelBackendProvenance:
    """Completed resource-consuming records should document model and backend."""

    def test_missing_model_warns_for_completed_resource_consuming(self, tmp_path):
        """Completed experiment with consumes_resources: true but no model field gets a warning."""
        fm = (
            "id: test-exp\nstatus: completed\ndate: 2026-02-27\nproject: test\n"
            "type: experiment\nconsumes_resources: true"
        )
        body = (
            "\n## Design\nTest.\n\n## Config\nModel: gemini-3-flash via local runner\nTest.\n\n"
            "## Results\nNone.\n\n## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        warn_msgs = [i.message for i in issues if i.level == "warning"]
        assert any("model" in m.lower() and "frontmatter" in m.lower() for m in warn_msgs)

    def test_missing_backend_warns_for_completed_resource_consuming(self, tmp_path):
        """Completed experiment with consumes_resources: true but no backend field gets a warning."""
        fm = (
            "id: test-exp\nstatus: completed\ndate: 2026-02-27\nproject: test\n"
            "type: experiment\nconsumes_resources: true\nmodel: gemini-3-flash"
        )
        body = (
            "\n## Design\nTest.\n\n## Config\nModel: gemini-3-flash via local runner\nTest.\n\n"
            "## Results\nNone.\n\n## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        warn_msgs = [i.message for i in issues if i.level == "warning"]
        assert any("backend" in m.lower() and "frontmatter" in m.lower() for m in warn_msgs)

    def test_model_and_backend_present_no_warning(self, tmp_path):
        """Completed experiment with model and backend in frontmatter produces no provenance warning."""
        fm = (
            "id: test-exp\nstatus: completed\ndate: 2026-02-27\nproject: test\n"
            "type: experiment\nconsumes_resources: true\nmodel: gemini-3-flash\nbackend: local-runner"
        )
        body = (
            "\n## Design\nTest.\n\n## Config\nModel: gemini-3-flash via local runner\nTest.\n\n"
            "## Results\nNone.\n\n## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        warn_msgs = [i.message for i in issues if i.level == "warning"]
        assert not any("frontmatter" in m.lower() and ("model" in m.lower() or "backend" in m.lower()) for m in warn_msgs)

    def test_planned_experiment_no_provenance_warning(self, tmp_path):
        """Planned experiments don't trigger provenance warnings."""
        fm = (
            "id: test-exp\nstatus: planned\ndate: 2026-02-27\nproject: test\n"
            "type: experiment\nconsumes_resources: true"
        )
        body = "\n## Design\nTest.\n\n## Config\nTest.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        warn_msgs = [i.message for i in issues if i.level == "warning"]
        assert not any("frontmatter" in m.lower() and "model" in m.lower() for m in warn_msgs)

    def test_non_resource_consuming_no_provenance_warning(self, tmp_path):
        """Completed record with consumes_resources: false doesn't trigger provenance warnings."""
        fm = (
            "id: test-exp\nstatus: completed\ndate: 2026-02-27\nproject: test\n"
            "type: analysis\nconsumes_resources: false"
        )
        body = "\n## Question\nTest.\n\n## Method\nTest.\n\n## Findings\nTest.\n"
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        warn_msgs = [i.message for i in issues if i.level == "warning"]
        assert not any("frontmatter" in m.lower() and "model" in m.lower() for m in warn_msgs)

    def test_missing_model_line_in_config_warns(self, tmp_path):
        """Completed resource-consuming record without 'Model:' in Config section gets a warning."""
        fm = (
            "id: test-exp\nstatus: completed\ndate: 2026-02-27\nproject: test\n"
            "type: experiment\nconsumes_resources: true\nmodel: gemini-3-flash\nbackend: local-runner"
        )
        body = (
            "\n## Design\nTest.\n\n## Config\nSome params but no model line.\n\n"
            "## Results\nNone.\n\n## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        warn_msgs = [i.message for i in issues if i.level == "warning"]
        assert any("model:" in m.lower() and "config" in m.lower() for m in warn_msgs)

    def test_model_line_in_config_no_warning(self, tmp_path):
        """Config section with 'Model:' line produces no section warning."""
        fm = (
            "id: test-exp\nstatus: completed\ndate: 2026-02-27\nproject: test\n"
            "type: experiment\nconsumes_resources: true\nmodel: gemini-3-flash\nbackend: local-runner"
        )
        body = (
            "\n## Design\nTest.\n\n## Config\nModel: gemini-3-flash via local runner\nSome params.\n\n"
            "## Results\nNone.\n\n## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        warn_msgs = [i.message for i in issues if i.level == "warning"]
        assert not any("model:" in m.lower() and "config" in m.lower() for m in warn_msgs)

    def test_model_line_in_method_no_warning(self, tmp_path):
        """Method section with 'Model:' line produces no section warning for analysis type."""
        fm = (
            "id: test-exp\nstatus: completed\ndate: 2026-02-27\nproject: test\n"
            "type: analysis\nconsumes_resources: true\nmodel: claude-opus-4.6\nbackend: claude-sdk"
        )
        body = (
            "\n## Question\nTest.\n\n## Method\nModel: claude-opus-4.6 via claude-sdk\nTest.\n\n"
            "## Findings\nTest.\n"
        )
        exp_dir = _make_experiment(tmp_path, fm, body)
        issues = validate_experiment(exp_dir)
        warn_msgs = [i.message for i in issues if i.level == "warning"]
        assert not any("model:" in m.lower() and "config" in m.lower() for m in warn_msgs)


# ── Literature citation verification ─────────────────────────────────────


def _make_project_with_literature(tmp_path: Path, lit_notes: dict[str, str],
                                   pub_content: str, pub_name: str = "benchmark-draft.md") -> Path:
    """Create a project directory with literature notes and a publication artifact.

    lit_notes: {filename: file_content}
    pub_content: content for the publication artifact
    """
    project_dir = tmp_path / "test-project"
    project_dir.mkdir()
    lit_dir = project_dir / "literature"
    lit_dir.mkdir()
    for fname, content in lit_notes.items():
        (lit_dir / fname).write_text(content)
    (project_dir / pub_name).write_text(pub_content)
    return project_dir


class TestLiteratureCitationVerification:
    """Publication artifacts must only cite literature notes with Verified: YYYY-MM-DD."""

    def test_verified_citation_no_error(self, tmp_path):
        """A citation referencing a verified literature note produces no error."""
        lit_notes = {
            "zheng2023-llm-judge.md": (
                "# LLM-as-Judge\n\n"
                "Citation: Zheng et al. 2023\n"
                "URL/DOI: https://arxiv.org/abs/2306.05685\n"
                "Verified: 2026-02-19\n"
                "CI layers: L4\n"
            ),
        }
        pub = (
            "# Draft\n\n"
            "LLMs achieve 80% agreement (Zheng et al., 2023).\n\n"
            "## References\n\n"
            "- Zheng et al. (2023). LLM-as-Judge.\n"
        )
        project_dir = _make_project_with_literature(tmp_path, lit_notes, pub)
        issues = validate_literature_citations(project_dir)
        assert len([i for i in issues if i.level == "error"]) == 0

    def test_unverified_citation_is_error(self, tmp_path):
        """A citation referencing a note with Verified: false produces an error."""
        lit_notes = {
            "zheng2023-llm-judge.md": (
                "# LLM-as-Judge\n\n"
                "Citation: Zheng et al. 2023\n"
                "URL/DOI: https://arxiv.org/abs/2306.05685\n"
                "Verified: false\n"
                "CI layers: L4\n"
            ),
        }
        pub = (
            "# Draft\n\n"
            "LLMs achieve 80% agreement (Zheng et al., 2023).\n\n"
            "## References\n\n"
            "- Zheng et al. (2023). LLM-as-Judge.\n"
        )
        project_dir = _make_project_with_literature(tmp_path, lit_notes, pub)
        issues = validate_literature_citations(project_dir)
        errors = [i for i in issues if i.level == "error"]
        assert len(errors) >= 1
        assert any("unverified" in i.message.lower() or "verified" in i.message.lower() for i in errors)

    def test_missing_verified_field_is_error(self, tmp_path):
        """A citation referencing a note without any Verified field produces an error."""
        lit_notes = {
            "zheng2023-llm-judge.md": (
                "# LLM-as-Judge\n\n"
                "Citation: Zheng et al. 2023\n"
                "URL/DOI: https://arxiv.org/abs/2306.05685\n"
                "CI layers: L4\n"
            ),
        }
        pub = (
            "# Draft\n\n"
            "LLMs achieve 80% agreement (Zheng et al., 2023).\n\n"
            "## References\n\n"
            "- Zheng et al. (2023). LLM-as-Judge.\n"
        )
        project_dir = _make_project_with_literature(tmp_path, lit_notes, pub)
        issues = validate_literature_citations(project_dir)
        errors = [i for i in issues if i.level == "error"]
        assert len(errors) >= 1

    def test_no_references_section_no_check(self, tmp_path):
        """Files without a ## References section are not publication artifacts — no check."""
        lit_notes = {
            "zheng2023-llm-judge.md": (
                "# LLM-as-Judge\n\n"
                "Citation: Zheng et al. 2023\n"
                "URL/DOI: https://arxiv.org/abs/2306.05685\n"
                "CI layers: L4\n"
            ),
        }
        pub = (
            "# Just a regular document\n\n"
            "Mentions Zheng et al., 2023 but is not a publication.\n"
        )
        project_dir = _make_project_with_literature(tmp_path, lit_notes, pub)
        issues = validate_literature_citations(project_dir)
        assert len(issues) == 0

    def test_no_literature_dir_no_check(self, tmp_path):
        """Projects without a literature/ directory produce no issues."""
        project_dir = tmp_path / "test-project"
        project_dir.mkdir()
        (project_dir / "benchmark-draft.md").write_text(
            "# Draft\n\n## References\n\n- Zheng et al. (2023).\n"
        )
        issues = validate_literature_citations(project_dir)
        assert len(issues) == 0

    def test_citation_not_matching_any_note_is_warning(self, tmp_path):
        """A citation in References that has no matching literature note is a warning."""
        lit_notes = {
            "zheng2023-llm-judge.md": (
                "# LLM-as-Judge\n\n"
                "Citation: Zheng et al. 2023\n"
                "URL/DOI: https://arxiv.org/abs/2306.05685\n"
                "Verified: 2026-02-19\n"
                "CI layers: L4\n"
            ),
        }
        pub = (
            "# Draft\n\n"
            "## References\n\n"
            "- Zheng et al. (2023). LLM-as-Judge.\n"
            "- Smith et al. (2025). Something New.\n"
        )
        project_dir = _make_project_with_literature(tmp_path, lit_notes, pub)
        issues = validate_literature_citations(project_dir)
        warnings = [i for i in issues if i.level == "warning"]
        assert len(warnings) >= 1
        assert any("smith" in i.message.lower() for i in warnings)

    def test_multiple_verified_citations_no_error(self, tmp_path):
        """Multiple citations all verified produces no errors."""
        lit_notes = {
            "zheng2023-llm-judge.md": (
                "# LLM-as-Judge\n\n"
                "Citation: Zheng et al. 2023\n"
                "URL/DOI: https://arxiv.org/abs/2306.05685\n"
                "Verified: 2026-02-19\n"
                "CI layers: L4\n"
            ),
            "chen2024-t3bench.md": (
                "# T3Bench\n\n"
                "Citation: Chen et al. 2024\n"
                "URL/DOI: https://arxiv.org/abs/2404.00000\n"
                "Verified: 2026-02-19\n"
                "CI layers: L4\n"
            ),
        }
        pub = (
            "# Draft\n\n"
            "Prior work (Zheng et al., 2023; Chen et al., 2024).\n\n"
            "## References\n\n"
            "- Zheng et al. (2023). LLM-as-Judge.\n"
            "- Chen et al. (2024). T3Bench.\n"
        )
        project_dir = _make_project_with_literature(tmp_path, lit_notes, pub)
        issues = validate_literature_citations(project_dir)
        assert len([i for i in issues if i.level == "error"]) == 0

    def test_mixed_verified_unverified_reports_only_unverified(self, tmp_path):
        """Only unverified citations are flagged; verified ones are fine."""
        lit_notes = {
            "zheng2023-llm-judge.md": (
                "# LLM-as-Judge\n\n"
                "Citation: Zheng et al. 2023\n"
                "URL/DOI: https://arxiv.org/abs/2306.05685\n"
                "Verified: 2026-02-19\n"
                "CI layers: L4\n"
            ),
            "chen2024-t3bench.md": (
                "# T3Bench\n\n"
                "Citation: Chen et al. 2024\n"
                "URL/DOI: https://arxiv.org/abs/2404.00000\n"
                "Verified: false\n"
                "CI layers: L4\n"
            ),
        }
        pub = (
            "# Draft\n\n"
            "## References\n\n"
            "- Zheng et al. (2023). LLM-as-Judge.\n"
            "- Chen et al. (2024). T3Bench.\n"
        )
        project_dir = _make_project_with_literature(tmp_path, lit_notes, pub)
        issues = validate_literature_citations(project_dir)
        errors = [i for i in issues if i.level == "error"]
        assert len(errors) == 1
        assert "chen" in errors[0].message.lower()

    def test_synthesis_md_excluded(self, tmp_path):
        """synthesis.md in literature/ is not a literature note — it should be skipped."""
        lit_notes = {
            "zheng2023-llm-judge.md": (
                "# LLM-as-Judge\n\n"
                "Citation: Zheng et al. 2023\n"
                "URL/DOI: https://arxiv.org/abs/2306.05685\n"
                "Verified: 2026-02-19\n"
                "CI layers: L4\n"
            ),
            "synthesis.md": (
                "# Literature Synthesis\n\nSummary of 8 papers.\n"
            ),
        }
        pub = (
            "# Draft\n\n"
            "## References\n\n"
            "- Zheng et al. (2023). LLM-as-Judge.\n"
        )
        project_dir = _make_project_with_literature(tmp_path, lit_notes, pub)
        issues = validate_literature_citations(project_dir)
        assert len([i for i in issues if i.level == "error"]) == 0


# ── Spot-check: CSV row count verification ────────────────────────────────


def _make_experiment_with_csv(tmp_path: Path, body: str, csv_name: str,
                               csv_rows: int, frontmatter: str | None = None) -> Path:
    """Create an experiment directory with an EXPERIMENT.md and a CSV file in results/."""
    exp_dir = tmp_path / "test-exp"
    exp_dir.mkdir()
    results_dir = exp_dir / "results"
    results_dir.mkdir()
    if frontmatter is None:
        frontmatter = (
            "id: test-exp\nstatus: completed\ndate: 2026-02-19\n"
            "project: test\ntype: experiment\nconsumes_resources: true"
        )
    (exp_dir / "EXPERIMENT.md").write_text(f"---\n{frontmatter}\n---\n{body}")
    # Create CSV with header + N data rows
    header = "task_id,model_a,model_b,winner\n"
    rows = "".join(f"{i},a,b,a\n" for i in range(csv_rows))
    (results_dir / csv_name).write_text(header + rows)
    return exp_dir


class TestCsvRowCountVerification:
    """EXPERIMENT.md claims about CSV row counts should match actual file contents."""

    def test_correct_row_count_no_warning(self, tmp_path):
        """When claimed row count matches actual CSV rows, no issue is reported."""
        body = (
            "\n## Design\nTest.\n\n## Config\nTest.\n\n"
            "## Results\n`results/data.csv` — 10 rows\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment_with_csv(tmp_path, body, "data.csv", 10)
        issues = validate_experiment(exp_dir)
        row_issues = [i for i in issues if "row count" in i.message.lower()]
        assert len(row_issues) == 0

    def test_wrong_row_count_is_warning(self, tmp_path):
        """When claimed row count doesn't match actual CSV rows, a warning is reported."""
        body = (
            "\n## Design\nTest.\n\n## Config\nTest.\n\n"
            "## Results\n`results/data.csv` — 50 rows\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment_with_csv(tmp_path, body, "data.csv", 10)
        issues = validate_experiment(exp_dir)
        row_issues = [i for i in issues if "row count" in i.message.lower()]
        assert len(row_issues) >= 1
        assert any("50" in i.message and "10" in i.message for i in row_issues)

    def test_row_count_with_context_text(self, tmp_path):
        """Row count claims with parenthetical context should still be parsed."""
        body = (
            "\n## Design\nTest.\n\n## Config\nTest.\n\n"
            "## Results\n`results/output.csv` — 265 rows (40 tasks × 6 pairs)\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment_with_csv(tmp_path, body, "output.csv", 265)
        issues = validate_experiment(exp_dir)
        row_issues = [i for i in issues if "row count" in i.message.lower()]
        assert len(row_issues) == 0

    def test_colon_format_row_count(self, tmp_path):
        """Row count claims in 'filename.csv: N rows' format should be parsed."""
        body = (
            "\n## Design\nTest.\n\n## Config\nTest.\n\n"
            "## Results\n`results/baseline.csv`: 15 rows — baseline mesh_quality\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment_with_csv(tmp_path, body, "baseline.csv", 15)
        issues = validate_experiment(exp_dir)
        row_issues = [i for i in issues if "row count" in i.message.lower()]
        assert len(row_issues) == 0

    def test_no_row_count_claim_no_check(self, tmp_path):
        """When EXPERIMENT.md doesn't claim any row counts, no check is performed."""
        body = (
            "\n## Design\nTest.\n\n## Config\nTest.\n\n"
            "## Results\n`results/data.csv` — experiment output\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment_with_csv(tmp_path, body, "data.csv", 42)
        issues = validate_experiment(exp_dir)
        row_issues = [i for i in issues if "row count" in i.message.lower()]
        assert len(row_issues) == 0

    def test_only_completed_experiments_checked(self, tmp_path):
        """Running/planned experiments should not have row count checks."""
        fm = (
            "id: test-exp\nstatus: running\ndate: 2026-02-19\n"
            "project: test\ntype: experiment\nconsumes_resources: true"
        )
        body = (
            "\n## Design\nTest.\n\n## Config\nTest.\n\n"
            "## Results\n`results/data.csv` — 50 rows\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        exp_dir = _make_experiment_with_csv(tmp_path, body, "data.csv", 10, frontmatter=fm)
        issues = validate_experiment(exp_dir)
        row_issues = [i for i in issues if "row count" in i.message.lower()]
        assert len(row_issues) == 0


# ── Spot-check: config.json n_runs verification ──────────────────────────


def _make_experiment_with_config(tmp_path: Path, body: str,
                                  config: dict, frontmatter: str | None = None) -> Path:
    """Create an experiment directory with EXPERIMENT.md and config.json."""
    import json
    exp_dir = tmp_path / "test-exp"
    exp_dir.mkdir()
    if frontmatter is None:
        frontmatter = (
            "id: test-exp\nstatus: completed\ndate: 2026-02-19\n"
            "project: test\ntype: experiment\nconsumes_resources: true"
        )
    (exp_dir / "EXPERIMENT.md").write_text(f"---\n{frontmatter}\n---\n{body}")
    (exp_dir / "config.json").write_text(json.dumps(config, indent=2))
    # Create minimal results CSV to avoid missing-file errors
    results_dir = exp_dir / "results"
    results_dir.mkdir()
    (results_dir / "dummy.csv").write_text("col\n1\n")
    return exp_dir


class TestConfigNrunsVerification:
    """EXPERIMENT.md claims about n_runs should match config.json."""

    def test_correct_nruns_no_warning(self, tmp_path):
        """When claimed n_runs matches config.json, no issue is reported."""
        body = (
            "\n## Design\nn_runs=4 for position bias mitigation.\n\n"
            "## Config\nTest.\n\n## Results\n`results/dummy.csv` — 1 rows\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        config = {"dataset": "test", "rendering_paths": {}, "n_runs": 4,
                  "questions_textured": ["q1"]}
        exp_dir = _make_experiment_with_config(tmp_path, body, config)
        issues = validate_experiment(exp_dir)
        nruns_issues = [i for i in issues if "n_runs" in i.message]
        assert len(nruns_issues) == 0

    def test_wrong_nruns_is_warning(self, tmp_path):
        """When claimed n_runs doesn't match config.json, a warning is reported."""
        body = (
            "\n## Design\nn_runs=6 for position bias mitigation.\n\n"
            "## Config\nTest.\n\n## Results\n`results/dummy.csv` — 1 rows\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        config = {"dataset": "test", "rendering_paths": {}, "n_runs": 4,
                  "questions_textured": ["q1"]}
        exp_dir = _make_experiment_with_config(tmp_path, body, config)
        issues = validate_experiment(exp_dir)
        nruns_issues = [i for i in issues if "n_runs" in i.message]
        assert len(nruns_issues) >= 1
        assert any("6" in i.message and "4" in i.message for i in nruns_issues)

    def test_nruns_colon_format(self, tmp_path):
        """n_runs: N format (with colon) should also be parsed."""
        body = (
            "\n## Design\nn_runs: 4 (2 forward + 2 reversed)\n\n"
            "## Config\nTest.\n\n## Results\n`results/dummy.csv` — 1 rows\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        config = {"dataset": "test", "rendering_paths": {}, "n_runs": 4,
                  "questions_textured": ["q1"]}
        exp_dir = _make_experiment_with_config(tmp_path, body, config)
        issues = validate_experiment(exp_dir)
        nruns_issues = [i for i in issues if "n_runs" in i.message]
        assert len(nruns_issues) == 0

    def test_no_nruns_claim_no_check(self, tmp_path):
        """When EXPERIMENT.md doesn't mention n_runs, no check is performed."""
        body = (
            "\n## Design\n4 runs per evaluation.\n\n"
            "## Config\nTest.\n\n## Results\n`results/dummy.csv` — 1 rows\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        config = {"dataset": "test", "rendering_paths": {}, "n_runs": 4,
                  "questions_textured": ["q1"]}
        exp_dir = _make_experiment_with_config(tmp_path, body, config)
        issues = validate_experiment(exp_dir)
        nruns_issues = [i for i in issues if "n_runs" in i.message]
        assert len(nruns_issues) == 0

    def test_no_config_nruns_no_check(self, tmp_path):
        """When config.json doesn't have n_runs, no check is performed."""
        body = (
            "\n## Design\nn_runs=4 for position bias.\n\n"
            "## Config\nTest.\n\n## Results\n`results/dummy.csv` — 1 rows\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        config = {"dataset": "test", "rendering_paths": {},
                  "questions_textured": ["q1"]}
        exp_dir = _make_experiment_with_config(tmp_path, body, config)
        issues = validate_experiment(exp_dir)
        nruns_issues = [i for i in issues if "n_runs" in i.message]
        assert len(nruns_issues) == 0

    def test_simgame_config_skipped(self, tmp_path):
        """Simulation game configs (with image/mesh keys) should not trigger n_runs check."""
        body = (
            "\n## Design\nn_runs=4 for testing.\n\n"
            "## Config\nTest.\n\n## Results\n`results/dummy.csv` — 1 rows\n\n"
            "## Findings\nTest.\n\n## Reproducibility\nTest.\n"
        )
        config = {"image": {"model": "test"}, "mesh": {"model": "test"}}
        exp_dir = _make_experiment_with_config(tmp_path, body, config)
        issues = validate_experiment(exp_dir)
        nruns_issues = [i for i in issues if "n_runs" in i.message]
        assert len(nruns_issues) == 0

    def test_nruns_in_findings_ignored(self, tmp_path):
        """n_runs mentions in Findings (cross-experiment refs) should NOT trigger a warning."""
        body = (
            "\n## Design\nn_runs=4 for position bias.\n\n"
            "## Config\nTest.\n\n## Results\n`results/dummy.csv` — 1 rows\n\n"
            "## Findings\nstrategic-100 with n_runs=1 could not produce ties.\n\n"
            "## Reproducibility\nTest.\n"
        )
        config = {"dataset": "test", "rendering_paths": {}, "n_runs": 4,
                  "questions_textured": ["q1"]}
        exp_dir = _make_experiment_with_config(tmp_path, body, config)
        issues = validate_experiment(exp_dir)
        nruns_issues = [i for i in issues if "n_runs" in i.message]
        assert len(nruns_issues) == 0, (
            f"n_runs=1 in Findings should not trigger warning: {nruns_issues}"
        )


# ── Submodule exclusion ──────────────────────────────────────────────────


class TestSubmoduleExclusion:
    """Validation must never traverse into git submodules (modules/ directory)."""

    def _make_repo_with_submodule(self, tmp_path: Path) -> Path:
        """Create a fake repo root with a modules/ submodule containing EXPERIMENT.md."""
        root = tmp_path / "repo"
        root.mkdir()
        # Real experiment
        real_exp = root / "projects" / "myproj" / "experiments" / "real-exp"
        real_exp.mkdir(parents=True)
        (real_exp / "EXPERIMENT.md").write_text(
            "---\nid: real-exp\nstatus: planned\ndate: 2026-01-01\n"
            "project: myproj\nconsumes_resources: false\ntype: analysis\n---\n\n## Question\nTest.\n"
        )
        # Submodule experiment (should be skipped)
        sub_exp = root / "modules" / "external-repo" / "experiments" / "sub-exp"
        sub_exp.mkdir(parents=True)
        (sub_exp / "EXPERIMENT.md").write_text(
            "---\nid: sub-exp\nstatus: planned\ndate: 2026-01-01\n"
            "project: external\nconsumes_resources: false\ntype: analysis\n---\n\n## Question\nTest.\n"
        )
        return root

    def test_find_experiments_skips_modules(self, tmp_path):
        """find_experiments should not return experiments inside modules/."""
        root = self._make_repo_with_submodule(tmp_path)
        experiments = find_experiments(root)
        exp_names = [e.name for e in experiments]
        assert "real-exp" in exp_names
        assert "sub-exp" not in exp_names

    def test_find_budget_dirs_skips_modules(self, tmp_path):
        """find_budget_dirs should not return budgets inside modules/."""
        root = tmp_path / "repo"
        root.mkdir()
        # Real budget
        real_proj = root / "projects" / "myproj"
        real_proj.mkdir(parents=True)
        (real_proj / "budget.yaml").write_text("resources: {}\n")
        # Submodule budget (should be skipped)
        sub_proj = root / "modules" / "external-repo"
        sub_proj.mkdir(parents=True)
        (sub_proj / "budget.yaml").write_text("resources: {}\n")
        budget_dirs = find_budget_dirs(root)
        budget_names = [d.name for d in budget_dirs]
        assert "myproj" in budget_names
        assert "external-repo" not in budget_names

    def test_cross_references_skips_modules(self, tmp_path):
        """validate_cross_references should not check markdown inside modules/."""
        root = tmp_path / "repo"
        root.mkdir()
        # Real markdown with a broken link
        (root / "README.md").write_text("See [guide](docs/guide.md) for details.\n")
        # Submodule markdown with a broken link (should NOT be reported)
        sub_dir = root / "modules" / "ext"
        sub_dir.mkdir(parents=True)
        (sub_dir / "README.md").write_text("See [missing](nonexistent.md) for details.\n")
        issues = validate_cross_references(root)
        issue_files = [i.message for i in issues]
        # The root README broken link should be found
        assert any("README.md" in m and "guide" in m for m in issue_files)
        # The modules/ broken link should NOT be found
        assert not any("modules" in m for m in issue_files)

    def test_in_skip_dir_detects_modules(self, tmp_path):
        """_in_skip_dir correctly identifies paths inside modules/."""
        root = tmp_path / "repo"
        root.mkdir()
        assert _in_skip_dir(root / "modules" / "foo" / "EXPERIMENT.md", root)
        assert not _in_skip_dir(root / "projects" / "bar" / "EXPERIMENT.md", root)
        assert _in_skip_dir(root / "node_modules" / "pkg" / "index.js", root)


# ── Stale approval-needed tag validation ─────────────────────────────────


def _make_repo_with_approval_queue(tmp_path: Path, queue_content: str,
                                    tasks_by_project: dict[str, str]) -> Path:
    """Create a repo with APPROVAL_QUEUE.md and TASKS.md files.

    tasks_by_project: {project_name: tasks_content}
    """
    root = tmp_path / "repo"
    root.mkdir()
    (root / "APPROVAL_QUEUE.md").write_text(queue_content)
    projects_dir = root / "projects"
    projects_dir.mkdir()
    for project_name, tasks_content in tasks_by_project.items():
        project_dir = projects_dir / project_name
        project_dir.mkdir()
        (project_dir / "TASKS.md").write_text(tasks_content)
    return root


class TestStaleApprovalTags:
    """Tasks with [approval-needed] that have matching resolved approvals should be flagged."""

    def test_no_stale_tags_no_warning(self, tmp_path):
        """When no tasks have stale approval tags, no warning is reported."""
        queue = "# Approval Queue\n\n## Resolved\n"
        tasks = "# Tasks\n\n- [ ] Some task\n"
        root = _make_repo_with_approval_queue(tmp_path, queue, {"myproj": tasks})
        issues = validate_stale_approval_tags(root)
        assert len(issues) == 0

    def test_stale_tag_is_warning(self, tmp_path):
        """A task with [approval-needed] matching a resolved approval is flagged."""
        queue = (
            "# Approval Queue\n\n## Resolved\n\n"
            "### 2026-02-26 — Add unit tests for validation\n"
            "Decision: approved\n"
        )
        tasks = (
            "# Tasks\n\n"
            "- [ ] Add unit tests for validation [approval-needed]\n"
        )
        root = _make_repo_with_approval_queue(tmp_path, queue, {"myproj": tasks})
        issues = validate_stale_approval_tags(root)
        assert len(issues) == 1
        assert issues[0].level == "warning"
        assert "stale" in issues[0].message.lower()

    def test_already_approved_no_warning(self, tmp_path):
        """A task with [approved: YYYY-MM-DD] is not flagged even if it has [approval-needed]."""
        queue = (
            "# Approval Queue\n\n## Resolved\n\n"
            "### 2026-02-26 — Add unit tests for validation\n"
            "Decision: approved\n"
        )
        tasks = (
            "# Tasks\n\n"
            "- [ ] Add unit tests for validation [approval-needed] [approved: 2026-02-26]\n"
        )
        root = _make_repo_with_approval_queue(tmp_path, queue, {"myproj": tasks})
        issues = validate_stale_approval_tags(root)
        assert len(issues) == 0

    def test_no_approval_queue_no_check(self, tmp_path):
        """If APPROVAL_QUEUE.md doesn't exist, no check is performed."""
        root = tmp_path / "repo"
        root.mkdir()
        projects_dir = root / "projects" / "myproj"
        projects_dir.mkdir(parents=True)
        (projects_dir / "TASKS.md").write_text(
            "# Tasks\n\n- [ ] Some task [approval-needed]\n"
        )
        issues = validate_stale_approval_tags(root)
        assert len(issues) == 0

    def test_pending_approval_not_flagged(self, tmp_path):
        """Tasks matching only pending approvals are not flagged."""
        queue = (
            "# Approval Queue\n\n## Pending\n\n"
            "### 2026-02-26 — Add unit tests for validation\n"
            "Request: needs approval\n"
        )
        tasks = (
            "# Tasks\n\n"
            "- [ ] Add unit tests for validation [approval-needed]\n"
        )
        root = _make_repo_with_approval_queue(tmp_path, queue, {"myproj": tasks})
        issues = validate_stale_approval_tags(root)
        assert len(issues) == 0

    def test_partial_match_is_warning(self, tmp_path):
        """Word overlap matching detects related approvals."""
        queue = (
            "# Approval Queue\n\n## Resolved\n\n"
            "### 2026-02-26 — Request art evaluation outputs\n"
            "Decision: approved\n"
        )
        tasks = (
            "# Tasks\n\n"
            "- [ ] Request art evaluation of dataset-collection outputs [approval-needed]\n"
        )
        root = _make_repo_with_approval_queue(tmp_path, queue, {"myproj": tasks})
        issues = validate_stale_approval_tags(root)
        # Should match due to word overlap (art, evaluation)
        assert len(issues) == 1

    def test_multiple_projects_checked(self, tmp_path):
        """All project TASKS.md files are checked."""
        queue = (
            "# Approval Queue\n\n## Resolved\n\n"
            "### 2026-02-26 — Task alpha\n"
            "Decision: approved\n"
            "### 2026-02-26 — Task beta\n"
            "Decision: approved\n"
        )
        tasks_a = "# Tasks\n\n- [ ] Task alpha [approval-needed]\n"
        tasks_b = "# Tasks\n\n- [ ] Task beta [approval-needed]\n"
        root = _make_repo_with_approval_queue(tmp_path, queue, {
            "proj-a": tasks_a, "proj-b": tasks_b
        })
        issues = validate_stale_approval_tags(root)
        assert len(issues) == 2


# ── Session footer validation ──────────────────────────────────────────────


class TestParseSessionFooter:
    """Tests for _parse_session_footer function."""

    def test_parses_fenced_footer(self):
        """Fenced code block footer is parsed correctly."""
        from validate import _parse_session_footer
        content = """### 2026-02-26 — Session

```
Session-type: autonomous
Duration: 15
Task-selected: fix widget
Task-completed: yes
Approvals-created: 0
Files-changed: 3
Commits: 1
Compound-actions: none
Resources-consumed: none
Budget-remaining: n/a
```
"""
        fields = _parse_session_footer(content)
        assert fields is not None
        assert fields.get("Session-type") == "autonomous"
        assert fields.get("Duration") == "15"
        assert fields.get("Budget-remaining") == "n/a"
        assert len(fields) == 10

    def test_parses_unfenced_footer(self):
        """Unfenced key-value block footer is parsed."""
        from validate import _parse_session_footer
        content = """### 2026-02-26 — Session

Some text.

Session-type: autonomous
Duration: 12
Task-selected: analysis
Task-completed: yes
Approvals-created: 0
Files-changed: 4
Commits: 2
Compound-actions: none
Resources-consumed: none
Budget-remaining: n/a

### Older entry
"""
        fields = _parse_session_footer(content)
        assert fields is not None
        assert fields.get("Duration") == "12"
        assert len(fields) == 10

    def test_returns_first_footer_when_multiple(self):
        """First (most recent) footer is returned."""
        from validate import _parse_session_footer
        content = """### 2026-02-26b — New

Session-type: autonomous
Duration: 25
Task-selected: new task
Task-completed: partial
Approvals-created: 1
Files-changed: 5
Commits: 2
Compound-actions: 1
Resources-consumed: api: 50
Budget-remaining: api: 950/1000

### 2026-02-26a — Old

Session-type: autonomous
Duration: 10
Task-selected: old task
Task-completed: yes
Approvals-created: 0
Files-changed: 2
Commits: 1
Compound-actions: none
Resources-consumed: none
Budget-remaining: n/a
"""
        fields = _parse_session_footer(content)
        assert fields is not None
        assert fields.get("Duration") == "25"
        assert fields.get("Task-selected") == "new task"

    def test_incomplete_footer_detected(self):
        """Incomplete footer returns only present fields."""
        from validate import _parse_session_footer
        content = """### 2026-02-26 — Session

Session-type: autonomous
Task-selected: incomplete

### Next
"""
        fields = _parse_session_footer(content)
        assert fields is not None
        assert len(fields) == 2
        assert "Duration" not in fields

    def test_no_footer_returns_none(self):
        """Returns None when no footer exists."""
        from validate import _parse_session_footer
        content = """### 2026-02-26 — Session

Just a log entry with no footer.

Sources: none
"""
        fields = _parse_session_footer(content)
        assert fields is None

    def test_footer_stops_at_blank_line(self):
        """Unfenced footer stops at blank line."""
        from validate import _parse_session_footer
        content = """Session-type: autonomous
Duration: 15
Task-selected: test

Approvals-created: 0
"""
        fields = _parse_session_footer(content)
        assert fields is not None
        assert len(fields) == 3
        assert "Approvals-created" not in fields


class TestValidateSessionFooters:
    """Tests for validate_session_footers function."""

    def test_complete_footer_no_warning(self, tmp_path):
        """README with complete footer produces no warning."""
        from validate import validate_session_footers
        projects = tmp_path / "projects"
        proj = projects / "myproj"
        proj.mkdir(parents=True)
        readme = proj / "README.md"
        readme.write_text("""# Project

## Log

### 2026-02-26 — Session

Session-type: autonomous
Duration: 15
Task-selected: test
Task-completed: yes
Approvals-created: 0
Files-changed: 3
Commits: 1
Compound-actions: none
Resources-consumed: none
Budget-remaining: n/a
""")
        issues = validate_session_footers(tmp_path)
        assert len(issues) == 0

    def test_incomplete_footer_produces_warning(self, tmp_path):
        """README with incomplete footer produces warning."""
        from validate import validate_session_footers
        projects = tmp_path / "projects"
        proj = projects / "myproj"
        proj.mkdir(parents=True)
        readme = proj / "README.md"
        readme.write_text("""# Project

## Log

### 2026-02-26 — Session

Session-type: autonomous
Task-selected: test

### Older
""")
        issues = validate_session_footers(tmp_path)
        assert len(issues) == 1
        assert "incomplete session footer" in issues[0].message.lower()
        assert "myproj" in issues[0].message

    def test_multiple_projects_scanned(self, tmp_path):
        """All project READMEs are scanned."""
        from validate import validate_session_footers
        projects = tmp_path / "projects"
        proj_a = projects / "proj-a"
        proj_b = projects / "proj-b"
        proj_a.mkdir(parents=True)
        proj_b.mkdir(parents=True)

        (proj_a / "README.md").write_text("""Session-type: autonomous
Task-selected: incomplete
""")
        (proj_b / "README.md").write_text("""Session-type: autonomous
Duration: 10
Task-selected: test
Task-completed: yes
Approvals-created: 0
Files-changed: 1
Commits: 1
Compound-actions: none
Resources-consumed: none
Budget-remaining: n/a
""")
        issues = validate_session_footers(tmp_path)
        assert len(issues) == 1
        assert "proj-a" in issues[0].message

    def test_no_projects_no_issues(self, tmp_path):
        """No issues if no project READMEs exist."""
        from validate import validate_session_footers
        issues = validate_session_footers(tmp_path)
        assert len(issues) == 0


# ── Production code reference validation ───────────────────────────────────


class TestExtractProductionCodePaths:
    """Tests for _extract_production_code_paths function."""

    def test_extracts_backtick_paths(self):
        from validate import _extract_production_code_paths
        content = """# Production Code

## Entry Point

```
modules/example-service/src/config.py
```

The `modules/example-service/utils.py` file has helpers.
"""
        paths = _extract_production_code_paths(content)
        path_strs = [p[0] for p in paths]
        assert "modules/example-service/src/config.py" in path_strs
        assert "modules/example-service/utils.py" in path_strs

    def test_detects_do_not_use_section_h2(self):
        from validate import _extract_production_code_paths
        content = """## Entry Point

`modules/real/path.py` is correct.

## DO NOT USE

`modules/fake/path.py` is wrong.
"""
        paths = _extract_production_code_paths(content)
        real_path = next(p for p in paths if p[0] == "modules/real/path.py")
        fake_path = next(p for p in paths if p[0] == "modules/fake/path.py")
        assert real_path[1] is False
        assert fake_path[1] is True

    def test_detects_do_not_use_section_h3(self):
        from validate import _extract_production_code_paths
        content = """## Entry Point

`modules/real/path.py` is correct.

### DO NOT USE (Non-Production Paths)

`modules/fake/path.py` is wrong.
"""
        paths = _extract_production_code_paths(content)
        fake_path = next(p for p in paths if p[0] == "modules/fake/path.py")
        assert fake_path[1] is True

    def test_no_paths_returns_empty(self):
        from validate import _extract_production_code_paths
        content = "# No paths here\n\nJust text."
        paths = _extract_production_code_paths(content)
        assert paths == []


class TestValidateProductionCodeReferences:
    """Tests for validate_production_code_references function."""

    def test_missing_path_is_error(self, tmp_path):
        """Path that doesn't exist in repo is an error."""
        from validate import validate_production_code_references
        projects = tmp_path / "projects"
        proj = projects / "myproj"
        proj.mkdir(parents=True)
        prod_md = proj / "production-code.md"
        prod_md.write_text("""# Production Code

`modules/nonexistent/path.py` does not exist.
""")
        issues = validate_production_code_references(tmp_path)
        assert len(issues) == 1
        assert issues[0].level == "error"
        assert "does not exist" in issues[0].message

    def test_existing_path_not_used_is_warning(self, tmp_path):
        """Path exists but not used in project scripts is a warning."""
        from validate import validate_production_code_references
        projects = tmp_path / "projects"
        proj = projects / "myproj"
        proj.mkdir(parents=True)
        experiments = proj / "experiments"
        experiments.mkdir(parents=True)
        (experiments / "script.py").write_text("# some script that doesn't use the path\n")
        modules = tmp_path / "modules" / "real"
        modules.mkdir(parents=True)
        (modules / "path.py").write_text("# real path")
        prod_md = proj / "production-code.md"
        prod_md.write_text("""# Production Code

`modules/real/path.py` exists but not used.
""")
        issues = validate_production_code_references(tmp_path)
        assert len(issues) == 1
        assert issues[0].level == "warning"
        assert "not found in any project script" in issues[0].message

    def test_path_used_in_script_no_warning(self, tmp_path):
        """Path used in project script produces no warning."""
        from validate import validate_production_code_references
        projects = tmp_path / "projects"
        proj = projects / "myproj"
        proj.mkdir(parents=True)
        experiments = proj / "experiments"
        experiments.mkdir(parents=True)
        (experiments / "script.py").write_text("from modules.real.path import something\n")
        modules = tmp_path / "modules" / "real"
        modules.mkdir(parents=True)
        (modules / "path.py").write_text("# real path")
        prod_md = proj / "production-code.md"
        prod_md.write_text("""# Production Code

`modules/real/path.py` is used.
""")
        issues = validate_production_code_references(tmp_path)
        assert len(issues) == 0

    def test_do_not_use_path_skips_usage_check(self, tmp_path):
        """Paths in DO NOT USE section skip usage verification."""
        from validate import validate_production_code_references
        projects = tmp_path / "projects"
        proj = projects / "myproj"
        proj.mkdir(parents=True)
        modules = tmp_path / "modules" / "fake"
        modules.mkdir(parents=True)
        (modules / "path.py").write_text("# fake path")
        prod_md = proj / "production-code.md"
        prod_md.write_text("""# Production Code

## DO NOT USE

`modules/fake/path.py` is deprecated.
""")
        issues = validate_production_code_references(tmp_path)
        assert len(issues) == 0

    def test_do_not_use_missing_path_is_warning(self, tmp_path):
        """DO NOT USE path that doesn't exist is a warning (not error)."""
        from validate import validate_production_code_references
        projects = tmp_path / "projects"
        proj = projects / "myproj"
        proj.mkdir(parents=True)
        prod_md = proj / "production-code.md"
        prod_md.write_text("""# Production Code

## DO NOT USE

`modules/nonexistent/path.py` does not exist.
""")
        issues = validate_production_code_references(tmp_path)
        assert len(issues) == 1
        assert issues[0].level == "warning"
        assert "DO NOT USE" in issues[0].message

    def test_no_production_code_md_no_issues(self, tmp_path):
        """Project without production-code.md produces no issues."""
        from validate import validate_production_code_references
        projects = tmp_path / "projects"
        proj = projects / "myproj"
        proj.mkdir(parents=True)
        issues = validate_production_code_references(tmp_path)
        assert len(issues) == 0

    def test_empty_production_code_md_is_warning(self, tmp_path):
        """production-code.md with no paths is a warning."""
        from validate import validate_production_code_references
        projects = tmp_path / "projects"
        proj = projects / "myproj"
        proj.mkdir(parents=True)
        prod_md = proj / "production-code.md"
        prod_md.write_text("# Production Code\n\nNo paths here.\n")
        issues = validate_production_code_references(tmp_path)
        assert len(issues) == 1
        assert issues[0].level == "warning"
        assert "no production code paths" in issues[0].message


# ── Experiment-only mode (scoped validation) ──────────────────────────


class TestExperimentOnlyMode:
    """When --experiment-only is passed, repo-wide checks (cross-refs, literature,
    stale approvals, session footers, production code) are skipped.
    This prevents unrelated repo issues from blocking autofix relaunches."""

    def _make_repo_with_broken_xref(self, tmp_path: Path) -> tuple[Path, Path]:
        """Create a repo where cross-references are broken but experiment is valid.

        Returns (repo_root, experiment_dir).
        """
        root = tmp_path / "repo"
        root.mkdir()
        (root / "AGENTS.md").write_text("# Repo root marker\n")

        # Valid experiment
        exp_dir = root / "projects" / "test" / "experiments" / "good-exp"
        exp_dir.mkdir(parents=True)
        (exp_dir / "EXPERIMENT.md").write_text(
            "---\n"
            "id: good-exp\n"
            "status: planned\n"
            "date: 2026-02-28\n"
            "project: test\n"
            "type: analysis\n"
            "consumes_resources: false\n"
            "---\n\n"
            "## Question\nTest question.\n"
        )

        # Broken cross-reference in an unrelated file
        (root / "knowledge.md").write_text(
            "See [nonexistent](docs/missing-file.md) for details.\n"
        )

        return root, exp_dir

    def test_experiment_only_skips_cross_references(self, tmp_path):
        """With --experiment-only, broken cross-references elsewhere don't cause failure."""
        from validate import main
        import sys

        root, exp_dir = self._make_repo_with_broken_xref(tmp_path)

        # Without --experiment-only: should fail due to broken xref
        sys.argv = ["validate.py", str(exp_dir)]
        exit_code_full = main()
        assert exit_code_full == 1, "Full validation should fail due to broken cross-ref"

        # With --experiment-only: should pass (experiment itself is valid)
        sys.argv = ["validate.py", "--experiment-only", str(exp_dir)]
        exit_code_scoped = main()
        assert exit_code_scoped == 0, "Experiment-only validation should pass"

    def test_experiment_only_still_validates_experiment(self, tmp_path):
        """With --experiment-only, the experiment itself is still validated."""
        from validate import main
        import sys

        root = tmp_path / "repo"
        root.mkdir()
        (root / "AGENTS.md").write_text("# Repo root marker\n")

        # Invalid experiment (missing required sections)
        exp_dir = root / "projects" / "test" / "experiments" / "bad-exp"
        exp_dir.mkdir(parents=True)
        (exp_dir / "EXPERIMENT.md").write_text(
            "---\n"
            "id: bad-exp\n"
            "status: completed\n"
            "date: 2026-02-28\n"
            "project: test\n"
            "type: experiment\n"
            "consumes_resources: true\n"
            "---\n\n"
            "## Design\nTest.\n"
            # Missing: Config, Results, Findings, Reproducibility
        )

        sys.argv = ["validate.py", "--experiment-only", str(exp_dir)]
        exit_code = main()
        assert exit_code == 1, "Experiment-only should still catch experiment errors"

    def test_experiment_only_skips_stale_approvals(self, tmp_path):
        """With --experiment-only, stale approval tag checks are skipped."""
        from validate import main
        import sys

        root = tmp_path / "repo"
        root.mkdir()
        (root / "AGENTS.md").write_text("# Root\n")
        (root / "APPROVAL_QUEUE.md").write_text(
            "# Queue\n\n## Resolved\n\n"
            "### 2026-02-26 — Fix widget\nDecision: approved\n"
        )
        projects = root / "projects" / "proj"
        projects.mkdir(parents=True)
        (projects / "TASKS.md").write_text(
            "# Tasks\n\n- [ ] Fix widget [approval-needed]\n"
        )

        # Valid experiment in the same repo
        exp_dir = root / "projects" / "proj" / "experiments" / "ok-exp"
        exp_dir.mkdir(parents=True)
        (exp_dir / "EXPERIMENT.md").write_text(
            "---\n"
            "id: ok-exp\n"
            "status: planned\n"
            "date: 2026-02-28\n"
            "project: proj\n"
            "type: analysis\n"
            "consumes_resources: false\n"
            "---\n\n"
            "## Question\nTest.\n"
        )

        sys.argv = ["validate.py", "--experiment-only", str(exp_dir)]
        exit_code = main()
        assert exit_code == 0, "Experiment-only should skip stale approval checks"
