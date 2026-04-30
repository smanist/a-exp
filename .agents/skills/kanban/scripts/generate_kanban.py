#!/usr/bin/env python3
"""Generate compressed a-exp project summaries for Obsidian kanban import."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path


TASK_RE = re.compile(r"^- \[([ xX])\]\s+(.+?)\s*$")


@dataclass
class Task:
    title: str
    done: bool


@dataclass
class LogSummary:
    label: str
    duration: str
    cost: str
    turns: str
    tokens: str


def compact_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def truncate(text: str, limit: int = 220) -> str:
    text = compact_space(text)
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def parse_tasks(tasks_path: Path) -> list[Task]:
    if not tasks_path.exists():
        return []
    tasks: list[Task] = []
    for line in read_text(tasks_path).splitlines():
        match = TASK_RE.match(line)
        if match:
            tasks.append(Task(title=match.group(2), done=match.group(1).lower() == "x"))
    return tasks


def parse_frontmatter_id(text: str, fallback: str) -> str:
    match = re.search(r"(?m)^id:\s*([A-Za-z0-9_.-]+)\s*$", text)
    return match.group(1) if match else fallback


def extract_section(text: str, heading: str) -> str:
    pattern = re.compile(
        rf"(?ims)^##\s+{re.escape(heading)}\s*$\n(?P<body>.*?)(?=^##\s+|\Z)"
    )
    match = pattern.search(text)
    return match.group("body").strip() if match else ""


def extract_bullets(section: str, max_items: int) -> list[str]:
    bullets = []
    for line in section.splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            bullets.append(truncate(stripped[2:]))
        if len(bullets) >= max_items:
            break
    return bullets


def extract_paragraph(section: str) -> str:
    lines = []
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("|") or stripped.startswith("!") or stripped.startswith("#"):
            continue
        if stripped.startswith("- "):
            continue
        lines.append(stripped)
    return truncate(" ".join(lines))


def summarize_markdown_result(path: Path, label: str, max_bullets: int) -> str:
    text = read_text(path)
    findings = extract_bullets(extract_section(text, "Findings"), max_bullets)
    conclusion = extract_paragraph(extract_section(text, "Conclusion"))
    if findings and conclusion:
        parts = findings + [conclusion]
    elif findings:
        parts = findings
    else:
        result_section = extract_section(text, "Results")
        parts = extract_bullets(result_section, max_bullets)
        if not parts:
            parts = [extract_paragraph(result_section or text)]
    joined = "; ".join(part for part in parts if part)
    return f"{label}: {joined or 'no concise result found'}"


def token_number(text: str) -> str:
    return text.replace(",", "")


def infer_log_label(text: str, tasks: list[Task], fallback: str) -> str:
    lowered = text.lower()
    matches = [task.title for task in tasks if task.title.lower() in lowered]
    if matches:
        return min(matches, key=len)
    patterns = [
        r"task [\"“](.*?)[\"”]",
        r"only open high-priority task:\s*(.+?)(?:\.|\n)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return truncate(match.group(1), 90)
    return fallback


def parse_log(path: Path, project: str, tasks: list[Task], fallback_label: str | None = None) -> LogSummary:
    text = read_text(path)
    stem = path.stem
    fallback = fallback_label or stem.removeprefix(project + "-")
    label = infer_log_label(text, tasks, fallback)

    duration = "unknown"
    cost = "unknown cost"
    turns = "unknown"
    tokens = "unknown"
    header = re.search(
        r"(?m)^# Duration:\s*([^,]+),\s*Cost:\s*([^,]+),\s*Turns:\s*([^,]+),\s*Tokens:\s*([\d,]+)\s+total",
        text,
    )
    if header:
        duration = header.group(1).strip()
        cost = header.group(2).strip()
        turns = header.group(3).strip()
        tokens = token_number(header.group(4).strip())
    return LogSummary(label=label, duration=duration, cost=cost, turns=turns, tokens=tokens)


def find_reports(repo_root: Path, project: str) -> list[Path]:
    project_reports = sorted((repo_root / "projects" / project / "reports").glob("**/*.md"))
    if project_reports:
        return project_reports

    top_reports = []
    all_projects = [p.name for p in (repo_root / "projects").iterdir() if p.is_dir()]
    for path in sorted((repo_root / "reports").glob("**/*.md")):
        if "kanban" in path.parts:
            continue
        text = read_text(path)
        if (
            f"Project: `{project}`" in text
            or f"Project: {project}" in text
            or f"projects/{project}/" in text
            or (len(all_projects) == 1 and path.name != ".gitkeep")
        ):
            top_reports.append(path)
    return top_reports


def cost_card(logs: list[LogSummary], max_items: int) -> str:
    if not logs:
        return "Cost: no `.a-exp/logs/<project>-*.log` entries found"
    pieces = []
    for log in logs[-max_items:]:
        pieces.append(
            f"{log.label}: {log.duration}, {log.tokens} tokens, {log.turns} turns, {log.cost}"
        )
    return "Cost: " + "; ".join(pieces)


def generate_project(repo_root: Path, project_dir: Path, args: argparse.Namespace) -> str:
    project = project_dir.name
    tasks = parse_tasks(project_dir / "TASKS.md")
    done = sum(1 for task in tasks if task.done)
    log_paths = sorted((repo_root / ".a-exp" / "logs").glob(f"{project}-*.log"))
    done_tasks = [task for task in tasks if task.done]
    use_task_order_fallback = len(log_paths) == len(done_tasks)
    logs = []
    for index, path in enumerate(log_paths):
        fallback_label = done_tasks[index].title if use_task_order_fallback else None
        logs.append(parse_log(path, project, tasks, fallback_label))

    lines = [
        f"## {project}-Tasks",
        f"- [x] Progress: {len(tasks)} in total, {done} done",
        f"- [x] {cost_card(logs, args.max_cost_items)}",
        "",
        f"## {project}-Results",
    ]

    experiment_paths = sorted((project_dir / "experiments").glob("*/EXPERIMENT.md"))
    if experiment_paths:
        for path in experiment_paths:
            text = read_text(path)
            exp_id = parse_frontmatter_id(text, path.parent.name)
            lines.append(
                "- [x] "
                + summarize_markdown_result(path, f"Experiment {exp_id}", args.max_result_bullets)
            )
    else:
        lines.append("- [ ] Experiment: no experiment records found")

    report_paths = find_reports(repo_root, project)
    if report_paths:
        for path in report_paths:
            report_id = path.stem
            lines.append(
                "- [x] "
                + summarize_markdown_result(path, f"Report {report_id}", args.max_result_bullets)
            )
    else:
        lines.append("- [ ] Report: no project reports found")

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate compressed Markdown summaries for a-exp project kanban review."
    )
    parser.add_argument("--repo-root", default=".", help="Repository root, default: current directory")
    parser.add_argument(
        "--output-dir",
        default="reports/kanban",
        help="Directory for <project>.md summaries, relative to repo root unless absolute",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print output instead of writing files")
    parser.add_argument("--max-cost-items", type=int, default=8)
    parser.add_argument("--max-result-bullets", type=int, default=3)
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    projects_root = repo_root / "projects"
    if not projects_root.is_dir():
        raise SystemExit(f"No projects directory found under {repo_root}")

    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = repo_root / output_dir

    summaries = {}
    for project_dir in sorted(path for path in projects_root.iterdir() if path.is_dir()):
        summaries[project_dir.name] = generate_project(repo_root, project_dir, args)

    if args.dry_run:
        for project, content in summaries.items():
            print(f"--- {project}.md ---")
            print(content)
        return 0

    output_dir.mkdir(parents=True, exist_ok=True)
    for project, content in summaries.items():
        (output_dir / f"{project}.md").write_text(content, encoding="utf-8")
        print(output_dir / f"{project}.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
