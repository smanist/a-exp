"""Validate structured work records (experiments, implementations, bugfixes, analyses).

Checks EXPERIMENT.md frontmatter, type-specific required sections, file references, and CSV integrity.
"""

import csv
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

# ── Schema ────────────────────────────────────────────────────────────────

REQUIRED_FRONTMATTER = {"id", "status", "date", "project", "consumes_resources"}
VALID_STATUSES = {"completed", "running", "planned", "failed", "abandoned"}
VALID_TYPES = {"experiment", "implementation", "bugfix", "analysis"}
VALID_CONSUMES_RESOURCES = {"true", "false"}

# Type -> status -> required sections.
SECTIONS_BY_TYPE_STATUS: dict[str, dict[str, set[str]]] = {
    "experiment": {
        "planned": {"Design", "Config"},
        "running": {"Design", "Config"},
        "completed": {"Design", "Config", "Results", "Findings", "Reproducibility"},
        "failed": {"Design", "Failure"},
        "abandoned": {"Design", "Failure"},
    },
    "implementation": {
        "planned": {"Specification"},
        "running": {"Specification"},
        "completed": {"Specification", "Changes", "Verification"},
        "failed": {"Specification", "Failure"},
        "abandoned": {"Specification", "Failure"},
    },
    "bugfix": {
        "planned": {"Problem"},
        "running": {"Problem"},
        "completed": {"Problem", "Root Cause", "Fix", "Verification"},
        "failed": {"Problem", "Failure"},
        "abandoned": {"Problem", "Failure"},
    },
    "analysis": {
        "planned": {"Question"},
        "running": {"Question"},
        "completed": {"Question", "Method", "Findings"},
        "failed": {"Question", "Failure"},
        "abandoned": {"Question", "Failure"},
    },
}

# Known pattern slugs (must match filenames in projects/akari/patterns/)
VALID_PATTERN_SLUGS = {
    "autonomous-execution",
    "gravity-driven-migration",
    "inline-logging",
    "layered-budget-enforcement",
    "repo-as-cognitive-state",
    "skills-architecture",
    "structured-work-records",
}

STALE_RUNNING_DAYS = 7

# Directories to skip in all repo-wide scans (rglob). Git submodules live in modules/.
SKIP_DIRS = {
    "node_modules", ".git", "dist", "__pycache__", ".pixi", ".cache",
    ".scheduler", ".pm2", "venv", ".venv", "modules",
}


def is_repo_root(path: Path) -> bool:
    """Return True when the directory looks like the openakari repo root."""
    return (path / "AGENTS.md").exists() or (path / ".git").exists()


def find_repo_root(start: Path) -> Path:
    """Walk up to the repo root using AGENTS.md or .git as the marker."""
    current = start.resolve()
    if current.is_file():
        current = current.parent
    while current.parent != current:
        if is_repo_root(current):
            return current
        current = current.parent
    return start.resolve()


def _in_skip_dir(path: Path, root: Path) -> bool:
    """Return True if path is inside any SKIP_DIRS relative to root."""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return False
    return any(p in SKIP_DIRS for p in parts)


# ── Parsing ───────────────────────────────────────────────────────────────


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Extract YAML frontmatter and body from EXPERIMENT.md content."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("---", 3)
    if end == -1:
        return {}, text
    fm_block = text[3:end].strip()
    body = text[end + 3 :].strip()
    fm = {}
    for line in fm_block.splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        # Parse list values like [a, b, c]
        if val.startswith("[") and val.endswith("]"):
            val = [v.strip().strip("\"'") for v in val[1:-1].split(",") if v.strip()]
        fm[key] = val
    return fm, body


def parse_sections(body: str) -> set[str]:
    """Extract H2 section names from markdown body."""
    sections = set()
    for line in body.splitlines():
        m = re.match(r"^##\s+(.+)$", line)
        if m:
            sections.add(m.group(1).strip())
    return sections


def extract_relative_paths(body: str) -> list[str]:
    """Find relative file paths referenced in markdown (backtick-quoted or link targets)."""
    paths = []
    # Backtick-quoted paths: `results/foo.csv`
    for m in re.finditer(r"`([^`]+\.\w+)`", body):
        candidate = m.group(1)
        if "/" in candidate and not candidate.startswith("http"):
            paths.append(candidate)
    # Markdown links: [text](path)
    for m in re.finditer(r"\[.*?\]\(([^)]+)\)", body):
        candidate = m.group(1)
        if not candidate.startswith("http") and not candidate.startswith("#"):
            paths.append(candidate)
    return paths


# ── Validation ────────────────────────────────────────────────────────────


class Issue:
    def __init__(self, level: str, message: str):
        self.level = level  # "error", "warning"
        self.message = message

    def __repr__(self) -> str:
        tag = "FAIL" if self.level == "error" else "WARN"
        return f"  [{tag}] {self.message}"


def validate_experiment(exp_dir: Path, root: Path | None = None) -> list[Issue]:
    """Validate a single experiment directory. Returns list of issues."""
    issues: list[Issue] = []
    exp_md = exp_dir / "EXPERIMENT.md"

    if not exp_md.exists():
        issues.append(Issue("error", "EXPERIMENT.md not found"))
        return issues

    text = exp_md.read_text()
    fm, body = parse_frontmatter(text)

    # Frontmatter checks
    missing_fm = REQUIRED_FRONTMATTER - set(fm.keys())
    if missing_fm:
        issues.append(Issue("error", f"Missing frontmatter fields: {', '.join(sorted(missing_fm))}"))

    exp_id = fm.get("id", "")
    if exp_id and exp_id != exp_dir.name:
        issues.append(Issue("error", f"ID '{exp_id}' does not match directory name '{exp_dir.name}'"))

    status = fm.get("status", "")
    if status and status not in VALID_STATUSES:
        issues.append(Issue("error", f"Invalid status '{status}' (expected one of: {', '.join(sorted(VALID_STATUSES))})"))

    # Type validation (defaults to "experiment" if absent)
    task_type = fm.get("type", "experiment")
    if task_type not in VALID_TYPES:
        issues.append(Issue("error", f"Invalid type '{task_type}' (expected one of: {', '.join(sorted(VALID_TYPES))})"))

    # consumes_resources validation
    cr_raw = fm.get("consumes_resources", "")
    if cr_raw and cr_raw not in VALID_CONSUMES_RESOURCES:
        issues.append(Issue("error", f"Invalid consumes_resources value '{cr_raw}' (expected true or false)"))
    elif cr_raw:
        cr_bool = cr_raw == "true"
        # Only experiment type has a hard constraint (must be true).
        # analysis, implementation, and bugfix allow either value — determined by
        # the lightweight resource-signal checklist.
        if task_type == "experiment" and not cr_bool:
            issues.append(Issue("error", "type 'experiment' must have consumes_resources: true"))

    requires_module_metadata = task_type != "analysis" or cr_raw == "true"
    module_fm = fm.get("module", "")
    artifacts_dir_fm = fm.get("artifacts_dir", "")
    if requires_module_metadata:
        if not module_fm:
            issues.append(Issue("error", "Missing 'module' in frontmatter for executable work"))
        if not artifacts_dir_fm:
            issues.append(Issue("error", "Missing 'artifacts_dir' in frontmatter for executable work"))
        elif not str(artifacts_dir_fm).startswith("modules/"):
            issues.append(Issue("error", "'artifacts_dir' must point under modules/<package>/"))

    # evidence_for validation (optional field)
    evidence_for = fm.get("evidence_for", "")
    if evidence_for:
        slugs = evidence_for if isinstance(evidence_for, list) else [evidence_for]
        for slug in slugs:
            if slug and slug not in VALID_PATTERN_SLUGS:
                issues.append(Issue("warning", f"Unknown pattern slug in evidence_for: '{slug}' (known: {', '.join(sorted(VALID_PATTERN_SLUGS))})"))

    # Model/backend provenance check (ADR 0043)
    # Warn when completed resource-consuming records lack model/backend frontmatter
    model_fm = fm.get("model", "")
    backend_fm = fm.get("backend", "")
    cr_val = fm.get("consumes_resources", "")
    if status == "completed" and cr_val == "true":
        if not model_fm:
            issues.append(Issue("warning", "Missing 'model' in frontmatter — completed resource-consuming record should document which model produced outputs (per ADR 0043)"))
        if not backend_fm:
            issues.append(Issue("warning", "Missing 'backend' in frontmatter — completed resource-consuming record should document which backend was used (per ADR 0043)"))

    # Check Config/Method section for Model: line in resource-consuming records
    if status in {"completed", "running"} and cr_val == "true":
        config_method_text = _extract_sections(body, {"Config", "Method"})
        if config_method_text and not re.search(r"^Model:", config_method_text, re.MULTILINE):
            issues.append(Issue("warning", "Config/Method section lacks 'Model:' line — resource-consuming records should document the model used (per ADR 0043)"))

    # Date validation
    date_str = fm.get("date", "")
    if date_str:
        try:
            exp_date = datetime.strptime(date_str, "%Y-%m-%d")
            if status == "running" and (datetime.now() - exp_date) > timedelta(days=STALE_RUNNING_DAYS):
                issues.append(Issue("warning", f"Experiment has been 'running' since {date_str} (>{STALE_RUNNING_DAYS} days)"))
        except ValueError:
            issues.append(Issue("error", f"Invalid date format '{date_str}' (expected YYYY-MM-DD)"))

    # Section checks (type-aware)
    type_sections = SECTIONS_BY_TYPE_STATUS.get(task_type, SECTIONS_BY_TYPE_STATUS["experiment"])
    if status in type_sections:
        required_sections = type_sections[status]
        present_sections = parse_sections(body)
        missing_sections = required_sections - present_sections
        if missing_sections:
            issues.append(Issue("error", f"Missing sections for type '{task_type}', status '{status}': {', '.join(sorted(missing_sections))}"))

    # File reference checks (lenient for running/planned experiments and analysis type)
    ref_paths = extract_relative_paths(body)
    for rp in ref_paths:
        # Skip validation for glob patterns or wildcards
        if "*" in rp or "<" in rp or ">" in rp:
            continue
            
        full = exp_dir / rp
        # Also check project-level paths for shared directories (ground-truth, etc.)
        project_level = exp_dir.parent.parent / rp  # experiments/exp-id → projects/project-name
        # Also check repo-root-relative paths (e.g., .scheduler/metrics/...)
        root_level = root / rp if root else None
        
        if not full.exists() and not project_level.exists() and (not root_level or not root_level.exists()):
            # For running/planned experiments, result files may not exist yet
            # Only error for completed/failed/abandoned experiments, or for non-result files
            # Skip for analysis type (often references conceptual paths)
            if task_type == "analysis":
                continue
            if status in {"completed", "failed", "abandoned"}:
                issues.append(Issue("error", f"Referenced file not found: {rp}"))
            elif not rp.startswith("results/") and not rp.startswith("analysis/"):
                issues.append(Issue("error", f"Referenced file not found: {rp}"))
            else:
                # Running/planned + results file → just a warning
                issues.append(Issue("warning", f"Referenced result file not yet generated: {rp}"))

    # CSV integrity checks
    for csv_path in exp_dir.rglob("*.csv"):
        try:
            with open(csv_path) as f:
                reader = csv.reader(f)
                header = next(reader, None)
                if header is None:
                    issues.append(Issue("error", f"CSV has no header: {csv_path.relative_to(exp_dir)}"))
                    continue
                row_count = sum(1 for _ in reader)
                if row_count == 0:
                    issues.append(Issue("error", f"CSV has 0 data rows: {csv_path.relative_to(exp_dir)}"))
        except Exception as e:
            issues.append(Issue("error", f"CSV read error in {csv_path.relative_to(exp_dir)}: {e}"))

    # Config file checks (experiment-pipeline experiments)
    config_json = exp_dir / "config.json"
    if config_json.exists():
        issues.extend(_validate_arena_config(config_json))

    # run.sh checks
    run_sh = exp_dir / "run.sh"
    if run_sh.exists():
        issues.extend(_validate_run_script(run_sh))

    # Spot-check validators (only for completed experiments)
    if status == "completed":
        issues.extend(_spot_check_csv_row_counts(exp_dir, body))
        issues.extend(_spot_check_config_nruns(exp_dir, body))

    return issues


# ── Spot-check validators ────────────────────────────────────────────────

# Patterns for CSV row count claims in EXPERIMENT.md:
#   `results/data.csv` — 265 rows
#   `results/data.csv`: 15 rows
_CSV_ROW_CLAIM_RE = re.compile(
    r"`(?:results/)?(\w[\w\-]*\.csv)`[`]?\s*(?:—|:|-)\s*(\d+)\s+rows?",
)


def _spot_check_csv_row_counts(exp_dir: Path, body: str) -> list[Issue]:
    """Verify that CSV row count claims in EXPERIMENT.md match actual files."""
    issues: list[Issue] = []
    for m in _CSV_ROW_CLAIM_RE.finditer(body):
        csv_name = m.group(1)
        claimed_rows = int(m.group(2))
        # Look for the CSV in results/ subdirectory
        csv_path = exp_dir / "results" / csv_name
        if not csv_path.exists():
            # Also try directly under exp_dir
            csv_path = exp_dir / csv_name
        if not csv_path.exists():
            continue  # File missing is caught by the file-reference check
        try:
            with open(csv_path) as f:
                reader = csv.reader(f)
                next(reader, None)  # skip header
                actual_rows = sum(1 for _ in reader)
            if actual_rows != claimed_rows:
                issues.append(Issue(
                    "warning",
                    f"CSV row count mismatch: EXPERIMENT.md claims {csv_name} has "
                    f"{claimed_rows} rows, but actual count is {actual_rows}",
                ))
        except Exception:
            pass  # CSV read errors are caught by the integrity check
    return issues


# Patterns for n_runs claims in EXPERIMENT.md:
#   n_runs=4
#   n_runs: 4
#   **n_runs:** 4
_NRUNS_CLAIM_RE = re.compile(r"\*{0,2}n_runs\*{0,2}\s*[=:]\s*(\d+)")


def _spot_check_config_nruns(exp_dir: Path, body: str) -> list[Issue]:
    """Verify that n_runs claims in EXPERIMENT.md Design/Config sections match config.json.

    Only checks Design and Config sections to avoid false positives from
    cross-experiment references in Findings (e.g., "strategic-100 with n_runs=1").
    """
    issues: list[Issue] = []
    config_path = exp_dir / "config.json"
    if not config_path.exists():
        return issues
    try:
        with open(config_path) as f:
            config = json.load(f)
    except (json.JSONDecodeError, OSError):
        return issues
    if not isinstance(config, dict):
        return issues
    # Skip simulation game configs
    if "image" in config and "mesh" in config:
        return issues
    config_nruns = config.get("n_runs")
    if config_nruns is None:
        return issues
    # Only check Design and Config sections to avoid false positives from
    # cross-experiment references in Findings/Results
    check_text = _extract_sections(body, {"Design", "Config"})
    if not check_text:
        return issues
    for m in _NRUNS_CLAIM_RE.finditer(check_text):
        claimed_nruns = int(m.group(1))
        if claimed_nruns != config_nruns:
            issues.append(Issue(
                "warning",
                f"n_runs mismatch: EXPERIMENT.md claims n_runs={claimed_nruns}, "
                f"but config.json has n_runs={config_nruns}",
            ))
    return issues


def _extract_sections(body: str, section_names: set[str]) -> str:
    """Extract the text content of specific H2 sections from a markdown body."""
    result_parts: list[str] = []
    current_section: str | None = None
    for line in body.splitlines():
        m = re.match(r"^##\s+(.+)$", line)
        if m:
            current_section = m.group(1).strip()
            continue
        if current_section in section_names:
            result_parts.append(line)
    return "\n".join(result_parts)


# ── Evaluation config validation ─────────────────────────────────────────

ARENA_REQUIRED_KEYS = {"dataset", "rendering_paths"}
ARENA_OPTIONAL_KEYS = {
    "dataset_path", "images", "rendering_format", "render_output_dir",
    "questions_textured", "questions_textureless", "n_runs", "batch_questions",
    "sample_count",
}

def _validate_arena_config(config_path: Path) -> list[Issue]:
    """Validate an experiment-pipeline config.json file."""
    issues: list[Issue] = []
    try:
        with open(config_path) as f:
            config = json.load(f)
    except json.JSONDecodeError as e:
        issues.append(Issue("error", f"config.json is not valid JSON: {e}"))
        return issues

    if not isinstance(config, dict):
        issues.append(Issue("error", "config.json must be a JSON object"))
        return issues

    # Required keys
    for key in ARENA_REQUIRED_KEYS:
        if key not in config:
            issues.append(Issue("error", f"config.json missing required key: '{key}'"))

    # Unknown keys
    known = ARENA_REQUIRED_KEYS | ARENA_OPTIONAL_KEYS
    for key in config:
        if key not in known:
            issues.append(Issue("warning", f"config.json unknown key: '{key}'"))

    # Questions check
    if not config.get("questions_textured") and not config.get("questions_textureless"):
        issues.append(Issue("error", "config.json: at least one of 'questions_textured' or 'questions_textureless' required"))

    return issues


def _validate_run_script(run_sh: Path) -> list[Issue]:
    """Check run.sh for common mistakes."""
    issues: list[Issue] = []
    content = run_sh.read_text()

    # Check for set -e or set -euo pipefail
    if "set -e" not in content and "set -euo" not in content:
        issues.append(Issue("warning", "run.sh: missing 'set -e' (errors may not halt execution)"))

    # Check for Gemini + --base-url combination (known to cause issues)
    lines = content.splitlines()
    in_gemini_block = False
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if "--provider gemini" in stripped:
            in_gemini_block = True
        if in_gemini_block and "--base-url" in stripped:
            issues.append(Issue("warning",
                f"run.sh line {i}: Gemini provider with --base-url may cause HttpOptions validation errors. "
                "See infra/experiment-pipeline/docs/provider-quirks.md"))
            in_gemini_block = False
        if stripped and not stripped.startswith("#") and not stripped.endswith("\\"):
            in_gemini_block = False

    return issues


def find_experiments(root: Path) -> list[Path]:
    """Find all experiment directories under a root path, skipping submodules."""
    experiments = []
    # If root itself is an experiment directory (has EXPERIMENT.md)
    if (root / "EXPERIMENT.md").exists():
        return [root]
    # Search for experiments/ subdirectories, skipping SKIP_DIRS
    for exp_md in root.rglob("EXPERIMENT.md"):
        if _in_skip_dir(exp_md, root):
            continue
        experiments.append(exp_md.parent)
    return sorted(experiments)


def check_id_uniqueness(experiments: list[Path]) -> list[Issue]:
    """Check for duplicate experiment IDs within the same project."""
    issues: list[Issue] = []
    # Group by project
    by_project: dict[str, list[str]] = {}
    for exp_dir in experiments:
        fm_text = (exp_dir / "EXPERIMENT.md").read_text()
        fm, _ = parse_frontmatter(fm_text)
        project = fm.get("project", "unknown")
        exp_id = fm.get("id", exp_dir.name)
        by_project.setdefault(project, []).append(exp_id)

    for project, ids in by_project.items():
        seen: set[str] = set()
        for eid in ids:
            if eid in seen:
                issues.append(Issue("error", f"Duplicate experiment ID '{eid}' in project '{project}'"))
            seen.add(eid)
    return issues


# ── Budget validation ─────────────────────────────────────────────────────

BUDGET_WARN_THRESHOLD = 0.9


def validate_budget(project_dir: Path) -> list[Issue]:
    """Validate budget.yaml and ledger.yaml in a project directory."""
    issues: list[Issue] = []
    budget_path = project_dir / "budget.yaml"
    ledger_path = project_dir / "ledger.yaml"

    if not budget_path.exists():
        return issues  # No budget — nothing to validate

    # Parse budget.yaml
    try:
        budget = yaml.safe_load(budget_path.read_text())
    except yaml.YAMLError as e:
        issues.append(Issue("error", f"budget.yaml parse error: {e}"))
        return issues

    if not isinstance(budget, dict):
        issues.append(Issue("error", "budget.yaml must be a YAML mapping"))
        return issues

    resources = budget.get("resources")
    if not isinstance(resources, dict):
        issues.append(Issue("error", "budget.yaml: 'resources' must be a mapping"))
        return issues

    for rtype, spec in resources.items():
        if not isinstance(spec, dict) or "limit" not in spec or "unit" not in spec:
            issues.append(Issue("error", f"budget.yaml: resource '{rtype}' must have 'limit' and 'unit'"))

    # Parse deadline
    deadline_raw = budget.get("deadline")
    deadline = None
    if deadline_raw:
        if isinstance(deadline_raw, datetime):
            deadline = deadline_raw
        elif isinstance(deadline_raw, str):
            try:
                deadline = datetime.fromisoformat(deadline_raw.replace("Z", "+00:00"))
            except ValueError:
                issues.append(Issue("error", f"budget.yaml: invalid deadline format '{deadline_raw}'"))

    # Check deadline
    if deadline:
        now = datetime.now(timezone.utc)
        if now > deadline:
            issues.append(Issue("error", f"Project deadline has passed ({deadline.isoformat()})"))
        elif (deadline - now) < timedelta(hours=24):
            issues.append(Issue("warning", f"Deadline is <24h away ({deadline.isoformat()})"))

    # Parse ledger.yaml
    if not ledger_path.exists():
        return issues  # No ledger yet — budget exists but nothing consumed

    try:
        ledger = yaml.safe_load(ledger_path.read_text())
    except yaml.YAMLError as e:
        issues.append(Issue("error", f"ledger.yaml parse error: {e}"))
        return issues

    if ledger is None:
        return issues  # Empty ledger file

    if not isinstance(ledger, dict):
        issues.append(Issue("error", "ledger.yaml must be a YAML mapping"))
        return issues

    entries = ledger.get("entries", [])
    if not isinstance(entries, list):
        issues.append(Issue("error", "ledger.yaml: 'entries' must be a list"))
        return issues

    # Validate entries and sum totals
    totals: dict[str, float] = {}
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            issues.append(Issue("error", f"ledger.yaml: entry {i} is not a mapping"))
            continue

        # Required fields
        for field in ("date", "resource", "amount"):
            if field not in entry:
                issues.append(Issue("error", f"ledger.yaml: entry {i} missing '{field}'"))

        if "experiment" not in entry and "session" not in entry:
            issues.append(Issue("error", f"ledger.yaml: entry {i} must have 'experiment' or 'session'"))

        # Cross-reference resource type
        resource = entry.get("resource")
        if resource and resource not in resources:
            issues.append(Issue("error", f"ledger.yaml: entry {i} resource '{resource}' not in budget.yaml"))

        # Accumulate
        amount = entry.get("amount", 0)
        if isinstance(amount, (int, float)):
            totals[resource] = totals.get(resource, 0) + amount

    # Check totals against limits
    for rtype, spec in resources.items():
        if not isinstance(spec, dict):
            continue
        limit = spec.get("limit", 0)
        consumed = totals.get(rtype, 0)
        if consumed > limit:
            issues.append(Issue("error", f"Budget exceeded for '{rtype}': {consumed}/{limit} {spec.get('unit', '')}"))
        elif limit > 0 and consumed / limit >= BUDGET_WARN_THRESHOLD:
            issues.append(Issue("warning", f"Budget >90% for '{rtype}': {consumed}/{limit} {spec.get('unit', '')}"))

    return issues


def find_budget_dirs(root: Path) -> list[Path]:
    """Find all directories containing budget.yaml under root, skipping submodules."""
    dirs = []
    if (root / "budget.yaml").exists():
        return [root]
    for budget_file in root.rglob("budget.yaml"):
        if _in_skip_dir(budget_file, root):
            continue
        dirs.append(budget_file.parent)
    return sorted(dirs)


# ── Cross-reference validation ────────────────────────────────────────────

# Directories to skip when scanning for markdown cross-references
# Reuses SKIP_DIRS and adds format-specific entries (pixi.lock is a file, not a dir)
XREF_SKIP_DIRS = SKIP_DIRS | {"pixi.lock"}

# File patterns that are documentation (not code), where broken links matter
XREF_GLOBS = ["**/*.md"]

# Link pattern — matches [text](path) but not URLs, anchors, or images
XREF_LINK_RE = re.compile(r"\[.*?\]\(([^)]+)\)")


def validate_cross_references(repo_root: Path) -> list[Issue]:
    """Check all markdown files under repo_root for broken relative links."""
    issues: list[Issue] = []

    md_files: list[Path] = []
    for pattern in XREF_GLOBS:
        md_files.extend(repo_root.glob(pattern))

    for md_file in sorted(set(md_files)):
        # Skip files in ignored directories
        parts = md_file.relative_to(repo_root).parts
        if any(p in XREF_SKIP_DIRS for p in parts):
            continue

        try:
            content = md_file.read_text(errors="replace")
        except OSError:
            continue

        in_code_block = False
        for line_num, line in enumerate(content.splitlines(), 1):
            # Track fenced code blocks — don't check links inside them
            if line.strip().startswith("```") or line.strip().startswith("~~~"):
                in_code_block = not in_code_block
                continue
            if in_code_block:
                continue

            # Strip inline code spans to avoid false positives (e.g., `[text](path)`)
            check_line = re.sub(r"`[^`]+`", "", line)
            for m in XREF_LINK_RE.finditer(check_line):
                target = m.group(1).strip()
                # Skip URLs, anchors, mailto, and template variables
                if (target.startswith("http") or target.startswith("#")
                        or target.startswith("mailto:") or "{{" in target):
                    continue
                # Strip anchor from path (e.g., "file.md#section")
                path_part = target.split("#")[0]
                if not path_part:
                    continue
                # Skip single-word placeholder targets (e.g., "path", "text")
                if re.match(r"^[a-z]+$", path_part):
                    continue
                # Skip glob patterns (e.g., "*.md", "src/*.ts")
                if "*" in path_part:
                    continue
                # Skip template-like paths (e.g., "<id>", "experiments/<id>/run.sh")
                if "<" in path_part or ">" in path_part:
                    continue
                # Resolve relative to the file's directory
                resolved = (md_file.parent / path_part).resolve()
                if not resolved.exists():
                    rel_file = md_file.relative_to(repo_root)
                    issues.append(Issue(
                        "error",
                        f"Broken link in {rel_file}:{line_num} → {target}"
                    ))

    return issues


# ── Stale approval-needed tag validation ─────────────────────────────────

# Pattern to match [approval-needed] tag in task lines
_APPROVAL_NEEDED_RE = re.compile(r"\[approval-needed\]")

# Pattern to match [approved: YYYY-MM-DD] tag
_APPROVED_RE = re.compile(r"\[approved:\s*(\d{4}-\d{2}-\d{2})\]")


def _extract_approval_needed_tasks(tasks_content: str) -> list[tuple[int, str]]:
    """Extract lines with [approval-needed] tag from TASKS.md content.

    Returns list of (line_number, task_text) tuples.
    """
    tasks = []
    for i, line in enumerate(tasks_content.splitlines(), 1):
        if _APPROVAL_NEEDED_RE.search(line):
            # Extract task text (remove checkbox and tags)
            task_text = line
            # Remove checkbox prefix like "- [ ] " or "- [x] "
            m = re.match(r"^-\s*\[[ x]\]\s*(.+)$", task_text)
            if m:
                task_text = m.group(1)
            # Remove trailing tags
            task_text = re.sub(r"\s*\[[^\]]+\]\s*$", "", task_text)
            task_text = re.sub(r"\s*\[[^\]]+\]", "", task_text).strip()
            tasks.append((i, task_text))
    return tasks


def _extract_approved_titles(queue_content: str) -> set[str]:
    """Extract approved item titles from APPROVAL_QUEUE.md Resolved section.

    Returns set of approved item titles (lowercase for case-insensitive matching).
    """
    approved = set()
    in_resolved = False
    for line in queue_content.splitlines():
        if line.strip() == "## Resolved":
            in_resolved = True
            continue
        if line.strip().startswith("## ") and in_resolved:
            in_resolved = False
        if in_resolved and line.startswith("### "):
            # Extract title after "### YYYY-MM-DD — "
            m = re.match(r"^###\s*\d{4}-\d{2}-\d{2}\s*[—–-]\s*(.+)$", line)
            if m:
                approved.add(m.group(1).strip().lower())
    return approved


def _task_matches_approved(task_text: str, approved_titles: set[str]) -> bool:
    """Check if a task text matches any approved title.

    Uses word overlap heuristic: if >50% of significant words in task appear
    in an approved title, consider it a match.
    """
    task_lower = task_text.lower()
    # Direct substring match
    for title in approved_titles:
        if title in task_lower or task_lower in title:
            return True
    # Word overlap match (for tasks with different phrasing)
    task_words = set(re.findall(r"\b\w{4,}\b", task_lower))
    if not task_words:
        return False
    for title in approved_titles:
        title_words = set(re.findall(r"\b\w{4,}\b", title))
        if not title_words:
            continue
        overlap = len(task_words & title_words)
        if overlap >= min(len(task_words), len(title_words)) * 0.5:
            return True
    return False


def validate_stale_approval_tags(repo_root: Path) -> list[Issue]:
    """Check for tasks with [approval-needed] that have matching resolved approvals.

    A stale tag is one where:
    - Task in TASKS.md has [approval-needed]
    - APPROVAL_QUEUE.md has a resolved approval matching the task
    - Task does NOT have [approved: YYYY-MM-DD]

    Returns warnings for each stale tag found.
    """
    issues: list[Issue] = []

    approval_queue = repo_root / "APPROVAL_QUEUE.md"
    if not approval_queue.exists():
        return issues

    try:
        queue_content = approval_queue.read_text()
    except OSError:
        return issues

    approved_titles = _extract_approved_titles(queue_content)
    if not approved_titles:
        return issues

    projects_dir = repo_root / "projects"
    if not projects_dir.is_dir():
        return issues

    for tasks_file in projects_dir.rglob("TASKS.md"):
        if _in_skip_dir(tasks_file, repo_root):
            continue
        try:
            tasks_content = tasks_file.read_text()
        except OSError:
            continue

        approval_needed_tasks = _extract_approval_needed_tasks(tasks_content)
        for line_num, task_text in approval_needed_tasks:
            # Check if task already has [approved: ...] tag
            full_line = tasks_content.splitlines()[line_num - 1]
            if _APPROVED_RE.search(full_line):
                continue  # Already approved, not stale
            # Check if task matches a resolved approval
            if _task_matches_approved(task_text, approved_titles):
                rel_path = tasks_file.relative_to(repo_root)
                issues.append(Issue(
                    "warning",
                    f"Stale [approval-needed] tag in {rel_path}:{line_num} — "
                    f"task '{task_text[:60]}...' may have been approved"
                ))

    return issues


# ── Literature citation verification ──────────────────────────────────────

# Pattern to extract author-year references from a References section.
# Matches "- Author et al. (YYYY)" and "- Author et al. (YYYY, letter)" style entries.
_REF_ENTRY_RE = re.compile(
    r"^-\s+(\w+)\s+(?:et\s+al\.\s+)?\((\d{4})\w?\)",
    re.MULTILINE,
)

# Files in literature/ that are not individual literature notes
_LIT_EXCLUDE = {"synthesis.md", "README.md"}

# Date pattern for Verified field: YYYY-MM-DD
_VERIFIED_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _find_publication_artifacts(project_dir: Path) -> list[Path]:
    """Find markdown files with a ## References section (publication artifacts)."""
    artifacts = []
    for md_file in sorted(project_dir.glob("*.md")):
        try:
            content = md_file.read_text(errors="replace")
        except OSError:
            continue
        if re.search(r"^## References", content, re.MULTILINE):
            artifacts.append(md_file)
    return artifacts


def _parse_references_section(content: str) -> list[tuple[str, str]]:
    """Extract (author_surname, year) pairs from the ## References section."""
    # Find the References section
    match = re.search(r"^## References\s*\n", content, re.MULTILINE)
    if not match:
        return []
    refs_text = content[match.end():]
    # Stop at the next H2 section
    next_section = re.search(r"^## ", refs_text, re.MULTILINE)
    if next_section:
        refs_text = refs_text[:next_section.start()]

    refs = []
    for m in _REF_ENTRY_RE.finditer(refs_text):
        author = m.group(1).lower()
        year = m.group(2)
        refs.append((author, year))
    return refs


def _load_literature_notes(lit_dir: Path) -> dict[str, str | None]:
    """Load literature notes and extract their Verified status.

    Returns: {filename: verified_value} where verified_value is:
    - A date string (e.g., "2026-02-19") if verified
    - "false" if explicitly unverified
    - None if the Verified field is missing
    """
    notes: dict[str, str | None] = {}
    if not lit_dir.is_dir():
        return notes
    for md_file in sorted(lit_dir.glob("*.md")):
        if md_file.name in _LIT_EXCLUDE:
            continue
        try:
            content = md_file.read_text(errors="replace")
        except OSError:
            continue
        # Look for "Verified: <value>" line
        vm = re.search(r"^Verified:\s*(.+)$", content, re.MULTILINE)
        if vm:
            notes[md_file.name] = vm.group(1).strip()
        else:
            notes[md_file.name] = None
    return notes


def _match_citation_to_note(author: str, year: str, note_filenames: list[str]) -> str | None:
    """Find a literature note filename matching an author-year citation.

    Matches filenames like "zheng2023-llm-judge.md" for author="zheng", year="2023".
    """
    prefix = f"{author}{year}"
    for fname in note_filenames:
        if fname.lower().startswith(prefix):
            return fname
    return None


def validate_literature_citations(project_dir: Path) -> list[Issue]:
    """Check that publication artifacts only cite verified literature notes."""
    issues: list[Issue] = []
    lit_dir = project_dir / "literature"
    if not lit_dir.is_dir():
        return issues

    notes = _load_literature_notes(lit_dir)
    if not notes:
        return issues

    artifacts = _find_publication_artifacts(project_dir)
    if not artifacts:
        return issues

    note_filenames = list(notes.keys())

    for artifact in artifacts:
        content = artifact.read_text(errors="replace")
        refs = _parse_references_section(content)
        for author, year in refs:
            matched_file = _match_citation_to_note(author, year, note_filenames)
            if matched_file is None:
                issues.append(Issue(
                    "warning",
                    f"{artifact.name}: citation '{author} et al. ({year})' has no matching "
                    f"literature note in literature/"
                ))
                continue

            verified_val = notes[matched_file]
            if verified_val is None:
                issues.append(Issue(
                    "error",
                    f"{artifact.name}: cites {matched_file} which has no Verified field"
                ))
            elif verified_val == "false":
                issues.append(Issue(
                    "error",
                    f"{artifact.name}: cites {matched_file} which is unverified (Verified: false)"
                ))
            elif not _VERIFIED_DATE_RE.match(verified_val):
                issues.append(Issue(
                    "error",
                    f"{artifact.name}: cites {matched_file} with invalid Verified value: '{verified_val}'"
                ))

    return issues


# ── Production code reference validation ───────────────────────────────────

_PROD_CODE_FILE_PATTERNS = [
    r"modules/[^\s`]+\.py",
    r"modules/[^\s`]+\.ts",
    r"modules/[^\s`]+\.tsx",
]

_PROD_CODE_PATH_INLINE_RE = re.compile(r"`(" + r"|".join(_PROD_CODE_FILE_PATTERNS) + r")`")
_PROD_CODE_PATH_BARE_RE = re.compile(r"^(" + r"|".join(_PROD_CODE_FILE_PATTERNS) + r")$")
_DO_NOT_USE_RE = re.compile(r"^#{2,4}\s+DO\s+NOT\s+USE", re.IGNORECASE)


def _extract_production_code_paths(content: str) -> list[tuple[str, bool]]:
    """Extract code paths from production-code.md content.

    Handles both inline backtick-quoted paths and fenced code block paths.
    Returns list of (path, in_do_not_use_section) tuples.
    """
    paths = []
    in_do_not_use = False
    in_fenced_block = False

    for line in content.splitlines():
        stripped = line.strip()
        
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fenced_block = not in_fenced_block
            continue
        
        if re.match(r"^#{2,4}\s+", stripped):
            in_do_not_use = bool(_DO_NOT_USE_RE.match(stripped))
            continue
        
        if in_fenced_block:
            m = _PROD_CODE_PATH_BARE_RE.match(stripped)
            if m:
                paths.append((m.group(1), in_do_not_use))
        else:
            for m in _PROD_CODE_PATH_INLINE_RE.finditer(line):
                paths.append((m.group(1), in_do_not_use))

    return paths


def _find_project_scripts(project_dir: Path) -> list[Path]:
    """Find Python scripts in project directory (experiments/, etc.)."""
    scripts = []
    for pattern in ["**/*.py"]:
        for f in project_dir.glob(pattern):
            if _in_skip_dir(f, project_dir):
                continue
            scripts.append(f)
    return sorted(scripts)


def _path_used_in_scripts(path: str, scripts: list[Path]) -> bool:
    """Check if a path is referenced in any of the given scripts."""
    for script in scripts:
        try:
            content = script.read_text(errors="replace")
        except OSError:
            continue
        if path in content:
            return True
        module_name = path.replace("/", ".").replace(".py", "")
        if module_name in content:
            return True
        import_name = path.split("/")[-1].replace(".py", "")
        if f"import {import_name}" in content or f"from {import_name}" in content:
            return True
    return False


def validate_production_code_references(repo_root: Path) -> list[Issue]:
    """Validate production-code.md files for path existence and usage.

    Checks:
    1. Paths mentioned in production-code.md exist in the repo
    2. Paths are actually used in project scripts (warning if not)
    3. "DO NOT USE" sections are properly formatted
    """
    issues: list[Issue] = []
    projects_dir = repo_root / "projects"
    if not projects_dir.is_dir():
        return issues

    for project_path in sorted(projects_dir.iterdir()):
        if not project_path.is_dir():
            continue

        prod_code_md = project_path / "production-code.md"
        if not prod_code_md.is_file():
            continue

        try:
            content = prod_code_md.read_text(errors="replace")
        except OSError:
            continue

        rel_prod = prod_code_md.relative_to(repo_root)
        paths = _extract_production_code_paths(content)

        if not paths:
            issues.append(Issue("warning", f"{rel_prod}: no production code paths found"))
            continue

        project_scripts = _find_project_scripts(project_path)

        for path, in_do_not_use in paths:
            full_path = repo_root / path
            if not full_path.exists():
                if in_do_not_use:
                    issues.append(Issue(
                        "warning",
                        f"{rel_prod}: 'DO NOT USE' path does not exist: {path}"
                    ))
                else:
                    issues.append(Issue(
                        "error",
                        f"{rel_prod}: path does not exist: {path}"
                    ))
                continue

            if in_do_not_use:
                continue

            if project_scripts and not _path_used_in_scripts(path, project_scripts):
                issues.append(Issue(
                    "warning",
                    f"{rel_prod}: path '{path}' not found in any project script"
                ))

    return issues


# ── Session footer validation ──────────────────────────────────────────────

REQUIRED_FOOTER_FIELDS = [
    "Session-type",
    "Duration",
    "Task-selected",
    "Task-completed",
    "Approvals-created",
    "Files-changed",
    "Commits",
    "Compound-actions",
    "Resources-consumed",
    "Budget-remaining",
]

_FOOTER_FIELD_RE = re.compile(r"^([A-Z][A-Za-z-]+):\s*(.+)$")


def _parse_session_footer(content: str) -> dict[str, str] | None:
    """Parse the most recent session footer from README content.

    A footer is either:
    (a) a fenced code block starting with "Session-type:", or
    (b) an unfenced block of key-value lines starting with "Session-type:"

    Returns the first (most recent) footer found, or None if no footer exists.
    """
    candidates: list[tuple[int, dict[str, str]]] = []

    fenced_re = re.compile(r"^(?:`{3,}|~{3,})[^\n]*\n([\s\S]*?)^(?:`{3,}|~{3,})\s*$", re.MULTILINE)
    for m in fenced_re.finditer(content):
        block = m.group(1)
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        if not lines or not lines[0].startswith("Session-type:"):
            continue
        fields: dict[str, str] = {}
        for line in lines:
            fm = _FOOTER_FIELD_RE.match(line)
            if fm:
                fields[fm.group(1)] = fm.group(2)
        if fields:
            candidates.append((m.start(), fields))

    fenced_ranges: list[tuple[int, int]] = [
        (m.start(), m.end()) for m in fenced_re.finditer(content)
    ]

    def inside_fence(pos: int) -> bool:
        return any(start <= pos < end for start, end in fenced_ranges)

    unfenced_re = re.compile(r"^Session-type:\s*.+$", re.MULTILINE)
    for m in unfenced_re.finditer(content):
        if inside_fence(m.start()):
            continue
        start = m.start()
        rest = content[start:]
        fields: dict[str, str] = {}
        for line in rest.split("\n"):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                break
            fm = _FOOTER_FIELD_RE.match(stripped)
            if not fm:
                break
            fields[fm.group(1)] = fm.group(2)
        if fields:
            candidates.append((start, fields))

    if not candidates:
        return None

    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]


def validate_session_footers(repo_root: Path) -> list[Issue]:
    """Check project README.md files for incomplete session footers.

    Validates that the most recent session footer in each project README contains
    all 10 required fields. Reports warnings for incomplete footers.
    """
    issues: list[Issue] = []
    projects_dir = repo_root / "projects"
    if not projects_dir.is_dir():
        return issues

    for project_path in sorted(projects_dir.iterdir()):
        if not project_path.is_dir():
            continue
        readme = project_path / "README.md"
        if not readme.is_file():
            continue
        try:
            content = readme.read_text(errors="replace")
        except OSError:
            continue

        fields = _parse_session_footer(content)
        if fields is None:
            continue

        missing = [f for f in REQUIRED_FOOTER_FIELDS if f not in fields]
        if missing:
            rel = readme.relative_to(repo_root)
            issues.append(Issue(
                "warning",
                f"Incomplete session footer in {rel}: missing {', '.join(missing)}"
            ))

    return issues


# ── CLI ───────────────────────────────────────────────────────────────────


def main() -> int:
    # Parse --experiment-only flag: skip repo-wide checks (cross-refs, literature, etc.)
    # Used by autofix to validate only the experiment dir without unrelated repo issues blocking.
    args = sys.argv[1:]
    experiment_only = False
    if "--experiment-only" in args:
        experiment_only = True
        args.remove("--experiment-only")

    if args:
        root = Path(args[0]).resolve()
    else:
        root = find_repo_root(Path(__file__).resolve())

    experiments = find_experiments(root)
    if not experiments:
        print(f"No experiments found under {root}")
        return 0

    total_pass = 0
    total_warn = 0
    total_fail = 0

    for exp_dir in experiments:
        issues = validate_experiment(exp_dir, root)
        errors = [i for i in issues if i.level == "error"]
        warnings = [i for i in issues if i.level == "warning"]

        if errors:
            status_str = "FAIL"
            total_fail += 1
        elif warnings:
            status_str = "WARN"
            total_warn += 1
        else:
            status_str = "PASS"
            total_pass += 1

        # Show path relative to root
        try:
            rel = exp_dir.relative_to(root)
        except ValueError:
            rel = exp_dir
        print(f"[{status_str}] {rel}")
        for issue in issues:
            print(repr(issue))

    # Global checks (experiment-scoped: only ID uniqueness within the given set)
    global_issues = check_id_uniqueness(experiments)
    for issue in global_issues:
        total_fail += 1
        print(repr(issue))

    # Repo-wide checks — skipped in experiment-only mode.
    # Autofix uses --experiment-only to prevent unrelated repo issues
    # (e.g., broken cross-references in knowledge.md) from blocking experiment relaunches.
    if not experiment_only:
        # Budget checks
        budget_dirs = find_budget_dirs(root)
        for bdir in budget_dirs:
            budget_issues = validate_budget(bdir)
            if budget_issues:
                try:
                    rel = bdir.relative_to(root)
                except ValueError:
                    rel = bdir
                errors = [i for i in budget_issues if i.level == "error"]
                warnings = [i for i in budget_issues if i.level == "warning"]
                if errors:
                    total_fail += 1
                    print(f"[FAIL] budget: {rel}")
                elif warnings:
                    total_warn += 1
                    print(f"[WARN] budget: {rel}")
                else:
                    print(f"[PASS] budget: {rel}")
                for issue in budget_issues:
                    print(repr(issue))

        # Cross-reference checks (markdown links across the repo)
        # Only run when validating from repo root (not a single experiment dir)
        repo_root = find_repo_root(root)

        if is_repo_root(repo_root):
            xref_issues = validate_cross_references(repo_root)
            xref_errors = [i for i in xref_issues if i.level == "error"]
            xref_warnings = [i for i in xref_issues if i.level == "warning"]
            if xref_issues:
                if xref_errors:
                    total_fail += 1
                    print(f"[FAIL] cross-references ({len(xref_errors)} broken links)")
                elif xref_warnings:
                    total_warn += 1
                    print(f"[WARN] cross-references")
                for issue in xref_issues:
                    print(repr(issue))
            else:
                total_pass += 1
                print("[PASS] cross-references")

        # Literature citation verification (per-project)
        if is_repo_root(repo_root):
            projects_dir = repo_root / "projects"
            if projects_dir.is_dir():
                for project_path in sorted(projects_dir.iterdir()):
                    if not project_path.is_dir():
                        continue
                    lit_issues = validate_literature_citations(project_path)
                    if lit_issues:
                        lit_errors = [i for i in lit_issues if i.level == "error"]
                        lit_warnings = [i for i in lit_issues if i.level == "warning"]
                        rel = project_path.relative_to(repo_root)
                        if lit_errors:
                            total_fail += 1
                            print(f"[FAIL] literature citations: {rel} ({len(lit_errors)} unverified)")
                        elif lit_warnings:
                            total_warn += 1
                            print(f"[WARN] literature citations: {rel}")
                        for issue in lit_issues:
                            print(repr(issue))
                    else:
                        if (project_path / "literature").is_dir():
                            rel = project_path.relative_to(repo_root)
                            total_pass += 1
                            print(f"[PASS] literature citations: {rel}")

        # Stale approval-needed tag check
        if (repo_root / "APPROVAL_QUEUE.md").exists():
            approval_issues = validate_stale_approval_tags(repo_root)
            if approval_issues:
                total_warn += 1
                print(f"[WARN] stale approval tags ({len(approval_issues)} tasks)")
                for issue in approval_issues:
                    print(repr(issue))
            else:
                total_pass += 1
                print("[PASS] stale approval tags")

        # Session footer completeness check
        footer_issues = validate_session_footers(repo_root)
        if footer_issues:
            total_warn += 1
            print(f"[WARN] incomplete session footers ({len(footer_issues)} issues)")
            for issue in footer_issues:
                print(repr(issue))
        else:
            total_pass += 1
            print("[PASS] session footers")

        # Production code reference validation
        prod_issues = validate_production_code_references(repo_root)
        if prod_issues:
            prod_errors = [i for i in prod_issues if i.level == "error"]
            prod_warnings = [i for i in prod_issues if i.level == "warning"]
            if prod_errors:
                total_fail += 1
                print(f"[FAIL] production-code references ({len(prod_errors)} errors)")
            else:
                total_warn += 1
                print(f"[WARN] production-code references ({len(prod_warnings)} warnings)")
            for issue in prod_issues:
                print(repr(issue))
        else:
            total_pass += 1
            print("[PASS] production-code references")

    print(f"\n{total_pass} passed, {total_warn} warnings, {total_fail} failed ({len(experiments)} experiments)")
    return 1 if total_fail > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
