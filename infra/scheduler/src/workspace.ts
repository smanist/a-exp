import { existsSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACE_DIR = ".a-exp";
export const LEGACY_STATE_DIR = ".scheduler";
export const CONFIG_PATH = join(WORKSPACE_DIR, "config.yaml");
export const LAYOUT_VERSION = 1;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface Workspace {
  root: string;
  configPath: string;
  stateDir: string;
  legacyStateDir: string;
  jobsPath: string;
  logsDir: string;
  metricsPath: string;
  interactionsPath: string;
  channelModesPath: string;
  modelPreferencePath: string;
  legacyBackendPreferencePath: string;
  lockDir: string;
}

export interface WorkspaceConfig {
  layoutVersion: number;
  scheduler?: {
    addDefaults?: SchedulerAddDefaults;
  };
}

export interface SchedulerAddDefaults {
  name?: string;
  cron?: string;
  everyMs?: number;
  tz?: string;
  message?: string;
  messageDefault?: boolean;
  messageProject?: string;
  model?: string;
  cwd?: string;
  maxDurationMs?: number;
}

export function workspacePaths(root: string): Workspace {
  const workspaceRoot = resolve(root);
  const stateDir = join(workspaceRoot, WORKSPACE_DIR);
  const legacyStateDir = join(workspaceRoot, LEGACY_STATE_DIR);
  return {
    root: workspaceRoot,
    configPath: join(workspaceRoot, CONFIG_PATH),
    stateDir,
    legacyStateDir,
    jobsPath: join(stateDir, "jobs.json"),
    logsDir: join(stateDir, "logs"),
    metricsPath: join(stateDir, "metrics", "sessions.jsonl"),
    interactionsPath: join(stateDir, "metrics", "interactions.jsonl"),
    channelModesPath: join(stateDir, "channel-modes.json"),
    modelPreferencePath: join(stateDir, "model-preference.json"),
    legacyBackendPreferencePath: join(stateDir, "backend-preference.json"),
    lockDir: stateDir,
  };
}

export function hasWorkspaceConfig(dir: string): boolean {
  return existsSync(join(dir, CONFIG_PATH));
}

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseSimpleYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];

  for (const rawLine of content.split("\n")) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const trimmed = rawLine.trim();
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;

    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].value;

    if (!rawValue) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseWorkspaceConfig(content: string): WorkspaceConfig {
  const raw = parseSimpleYaml(content);
  const scheduler = asRecord(raw.scheduler);
  const addDefaults = asRecord(scheduler?.add_defaults);
  return {
    layoutVersion: asNumber(raw.layout_version) ?? LAYOUT_VERSION,
    ...(addDefaults ? {
      scheduler: {
        addDefaults: {
          name: asString(addDefaults.name),
          cron: asString(addDefaults.cron),
          everyMs: asNumber(addDefaults.every_ms),
          tz: asString(addDefaults.tz),
          message: asString(addDefaults.message),
          messageDefault: asBoolean(addDefaults.message_default),
          messageProject: asString(addDefaults.message_project),
          model: asString(addDefaults.model),
          cwd: asString(addDefaults.cwd),
          maxDurationMs: asNumber(addDefaults.max_duration_ms),
        },
      },
    } : {}),
  };
}

export function readWorkspaceConfig(configPath: string): WorkspaceConfig {
  return parseWorkspaceConfig(readFileSync(configPath, "utf-8"));
}

export function findWorkspaceRoot(startDir = process.cwd()): string | null {
  let current = resolve(startDir);
  const root = parse(current).root;
  while (true) {
    if (hasWorkspaceConfig(current)) return current;
    if (current === root) return null;
    current = dirname(current);
  }
}

export function resolveWorkspace(opts: {
  repo?: string;
  startDir?: string;
  requireConfig?: boolean;
} = {}): Workspace | null {
  const requireConfig = opts.requireConfig ?? true;
  const root = opts.repo ? resolve(opts.repo) : findWorkspaceRoot(opts.startDir);
  if (!root) return null;
  if (requireConfig && !hasWorkspaceConfig(root)) return null;
  return workspacePaths(root);
}

export function legacyWorkspacePaths(root: string): Workspace {
  const paths = workspacePaths(root);
  return {
    ...paths,
    stateDir: paths.legacyStateDir,
    jobsPath: join(paths.legacyStateDir, "jobs.json"),
    logsDir: join(paths.legacyStateDir, "logs"),
    metricsPath: join(paths.legacyStateDir, "metrics", "sessions.jsonl"),
    interactionsPath: join(paths.legacyStateDir, "metrics", "interactions.jsonl"),
    channelModesPath: join(paths.legacyStateDir, "channel-modes.json"),
    modelPreferencePath: join(paths.legacyStateDir, "model-preference.json"),
    legacyBackendPreferencePath: join(paths.legacyStateDir, "backend-preference.json"),
    lockDir: paths.legacyStateDir,
  };
}

export async function initWorkspace(root: string): Promise<string[]> {
  const workspace = workspacePaths(root);
  await mkdir(workspace.root, { recursive: true });
  if (!isGitRepositoryRoot(workspace.root)) {
    gitCommand(workspace.root, ["init"]);
  }
  const kit = resolveSiblingKit(workspace.root);
  const created: string[] = [];
  const stagePaths: string[] = [];

  await ensureDir(workspace.stateDir, created, stagePaths, workspace.root);
  await ensureFile(
    workspace.configPath,
    defaultConfig(kit.selfHosting),
    created,
    stagePaths,
    workspace.root,
  );
  await ensureFile(
    join(workspace.stateDir, "kit.lock.yaml"),
    kitLock(kit),
    created,
    stagePaths,
    workspace.root,
  );
  await ensureFile(
    join(workspace.root, ".gitignore"),
    defaultGitignore(),
    created,
    stagePaths,
    workspace.root,
  );
  await ensureDir(join(workspace.root, ".vscode"), created, stagePaths, workspace.root);
  await ensureFile(
    join(workspace.root, ".vscode", "settings.json"),
    vscodeTemplate("settings.json"),
    created,
    stagePaths,
    workspace.root,
  );
  await ensureFile(
    join(workspace.root, ".vscode", "tasks.json"),
    vscodeTemplate("tasks.json"),
    created,
    stagePaths,
    workspace.root,
  );
  await ensureSymlink(join(workspace.root, ".agents"), "../a-exp/.agents", created, stagePaths, workspace.root, kit.selfHosting);
  await ensureSymlink(join(workspace.root, "docs"), "../a-exp/docs", created, stagePaths, workspace.root, kit.selfHosting);
  await ensureFile(
    join(workspace.root, "AGENTS.md"),
    defaultAgents(),
    created,
    stagePaths,
    workspace.root,
  );
  await ensureDir(join(workspace.root, "projects"), created, stagePaths, workspace.root);
  await ensureFile(join(workspace.root, "projects", ".gitkeep"), "", created, stagePaths, workspace.root);
  await ensureDir(join(workspace.root, "projects", "a-exp"), created, stagePaths, workspace.root);
  await ensureFile(
    join(workspace.root, "projects", "a-exp", "README.md"),
    defaultAExpProjectReadme(),
    created,
    stagePaths,
    workspace.root,
  );
  await ensureFile(
    join(workspace.root, "projects", "a-exp", "TASKS.md"),
    defaultAExpProjectTasks(),
    created,
    stagePaths,
    workspace.root,
  );
  await ensureFile(
    join(workspace.root, "modules", "registry.yaml"),
    defaultRegistry(),
    created,
    stagePaths,
    workspace.root,
  );
  await ensureDir(join(workspace.root, "reports"), created, stagePaths, workspace.root);
  await ensureFile(join(workspace.root, "reports", ".gitkeep"), "", created, stagePaths, workspace.root);
  await ensureFile(
    join(workspace.root, "APPROVAL_QUEUE.md"),
    defaultApprovalQueue(),
    created,
    stagePaths,
    workspace.root,
  );

  commitCreatedWorkspaceFiles(workspace.root, stagePaths);

  return created;
}

function resolveSiblingKit(root: string): {
  source: string;
  commit: string;
  dirty: boolean;
  selfHosting: boolean;
} {
  const selfHosting = basename(root) === "a-exp";
  const source = selfHosting ? root : join(dirname(root), "a-exp");
  if (!existsSync(join(source, ".agents", "skills")) || !existsSync(join(source, "docs"))) {
    throw new Error(`a-exp kit not found at ${source}. Initialize project repos next to a-exp so kit links resolve via ../a-exp.`);
  }
  return {
    source,
    commit: gitOutput(source, ["rev-parse", "HEAD"]) ?? "unknown",
    dirty: (gitOutput(source, ["status", "--short"]) ?? "").trim().length > 0,
    selfHosting,
  };
}

async function ensureDir(path: string, created: string[], stagePaths: string[], root: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(path, { recursive: true });
  const relPath = relativePath(root, path);
  created.push(relPath + "/");
  stagePaths.push(relPath);
}

async function ensureFile(path: string, content: string, created: string[], stagePaths: string[], root: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  const relPath = relativePath(root, path);
  created.push(relPath);
  stagePaths.push(relPath);
}

async function ensureSymlink(
  path: string,
  target: string,
  created: string[],
  stagePaths: string[],
  root: string,
  skip: boolean,
): Promise<void> {
  if (skip || existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, "dir");
  const relPath = relativePath(root, path);
  created.push(`${relPath} -> ${target}`);
  stagePaths.push(relPath);
}

function relativePath(root: string, path: string): string {
  return path.slice(root.length + 1);
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function gitCommand(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: gitCommitEnv(),
    stdio: "ignore",
  });
}

function isGitRepositoryRoot(root: string): boolean {
  const topLevel = gitOutput(root, ["rev-parse", "--show-toplevel"]);
  return topLevel !== null && resolve(topLevel) === root;
}

function commitCreatedWorkspaceFiles(root: string, stagePaths: string[]): void {
  const uniqueStagePaths = Array.from(new Set(stagePaths));
  if (uniqueStagePaths.length === 0) return;

  gitCommand(root, ["add", "--", ...uniqueStagePaths]);
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--exit-code"], { cwd: root, stdio: "ignore" });
    return;
  } catch {
    // Exit code 1 means there are staged changes to commit.
  }
  gitCommand(root, ["-c", "commit.gpgsign=false", "commit", "-m", "Initialize a-exp workspace"]);
}

function gitCommitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "a-exp",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "a-exp@example.local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "a-exp",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "a-exp@example.local",
  };
}

function defaultAgents(): string {
  return `# AGENTS.md

This repo is an a-exp project workspace. It uses the sibling a-exp operating kit through local symlinks:

- \`.agents -> ../a-exp/.agents\`
- \`docs -> ../a-exp/docs\`

The kit commit is recorded in \`.a-exp/kit.lock.yaml\`. If a symlink is broken, keep this repo parallel to the a-exp repo so \`../a-exp\` resolves correctly.

## Repository Layout

- \`.a-exp/config.yaml\` records workspace metadata.
- \`.a-exp/kit.lock.yaml\` records the sibling a-exp kit commit used at init time.
- \`.vscode/\` contains VS Code settings and tasks copied from the a-exp kit templates.
- \`AGENTS.md\` is the operating contract for agents in this project repo.
- \`.agents/skills/\` exposes local a-exp skills from \`../a-exp\`.
- \`docs/\` exposes schemas and conventions from \`../a-exp\`.
- \`projects/<project>/README.md\` records mission, context, log, and open questions.
- \`projects/<project>/TASKS.md\` records bounded next actions.
- \`projects/<project>/budget.yaml\` declares lightweight resource limits when needed.
- \`projects/<project>/ledger.yaml\` records declared usage when needed.
- \`projects/<project>/plans/\` holds non-trivial plans.
- \`projects/<project>/experiments/<id>/EXPERIMENT.md\` holds experiment records.
- \`modules/registry.yaml\` maps projects to execution modules.
- \`modules/<module>/\` holds project-owned code and heavy artifacts.
- \`modules/<module>/artifacts/<experiment-id>/\` holds run outputs.
- \`reports/\` holds generated reports.
- \`APPROVAL_QUEUE.md\` records pending human approvals.

## Work Cycle

1. Read the relevant \`projects/<project>/README.md\` and \`projects/<project>/TASKS.md\`.
2. Select an unblocked task with concrete \`Done when\` criteria.
3. Make the smallest cohesive change that satisfies the task.
4. Verify with the narrowest useful tests or checks.
5. Update the project log with what changed and the exact verification command.
6. Commit the completed logical unit.

## Recording Rules

- Non-obvious discovery -> record it in the project files in the same turn.
- Decision -> record it in a project log or plan before relying on it later.
- Non-trivial plan -> write it under \`projects/<project>/plans/\`.
- Experiment -> create or update \`projects/<project>/experiments/<id>/EXPERIMENT.md\`.
- Verification -> log the exact command and result in the project README.
- Open question -> add it to the project's \`## Open questions\` section.
- Heavy outputs -> keep them under \`modules/<module>/artifacts/\`.

## Tasks

Tasks use this shape:

\`\`\`markdown
- [ ] Imperative task title
  Why: Why this matters.
  Done when: Mechanically verifiable completion condition.
  Priority: high|medium|low
\`\`\`

Tasks may also use multiple \`Done when\` criteria when a mid-sized task has several acceptance checks:

\`\`\`markdown
- [ ] Imperative task title
  Why: Why this matters.
  Done when:
  - Mechanically verifiable completion condition.
  - Another mechanically verifiable completion condition.
  Priority: high|medium|low
\`\`\`

Prefer mid-sized coherent tasks by default. Split tasks only when the pieces are independently useful, independently verifiable, require separate approvals or resources, or are unlikely to fit in one agent session. If the user asks for finer or coarser decomposition during scaffolding or task creation, honor that request when each resulting task remains bounded and verifiable.

Use \`[blocked-by: ...]\` only for conditions outside agent control, such as missing credentials or explicit human approval.

## Budgets

Budget support is lightweight. \`budget.yaml\` declares limits; \`ledger.yaml\` records declared usage. Reports may summarize these files, but a-exp does not audit external providers or enforce provider-backed accounting.

## Experiments

Do not supervise long-running experiments in an agent session. Keep experiment records in \`projects/<project>/experiments/\` and heavy outputs in \`modules/<module>/artifacts/\`.

## Scheduler

Use the installed \`a-exp\` CLI from this workspace:

- \`a-exp start\`, \`a-exp stop\`
- \`a-exp add\`, \`a-exp run\`, \`a-exp remove\`, \`a-exp enable\`, \`a-exp disable\`
- \`a-exp status\`, \`a-exp heartbeat\`, \`a-exp check-health\`

The scheduler must run without Slack tokens; Slack functions should degrade to no-ops.
`;
}

function vscodeTemplate(name: "settings.json" | "tasks.json"): string {
  return readFileSync(join(MODULE_DIR, "..", "templates", "vscode", name), "utf-8");
}

function defaultConfig(selfHosting: boolean): string {
  return `layout_version: ${LAYOUT_VERSION}
kit:
  mode: ${selfHosting ? "local" : "symlink"}
  source: ${selfHosting ? "." : "../a-exp"}
scheduler:
  add_defaults:
    name: work-cycle
    cron: "0 * * * *"
    message_default: true
    model: strong
    cwd: "."
    max_duration_ms: 1800000
`;
}

function kitLock(kit: { commit: string; dirty: boolean; selfHosting: boolean }): string {
  return `source: ../a-exp
commit: ${kit.commit}
dirty: ${kit.dirty ? "true" : "false"}
self_hosting: ${kit.selfHosting ? "true" : "false"}
`;
}

function defaultRegistry(): string {
  return `entries: []
`;
}

function defaultAExpProjectReadme(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `# a-exp

Status: active
Priority: high
Mission: Maintain this a-exp workspace as a small, runnable agent research scaffold.
Done when: Scheduler jobs, project creation, reports, budgets, and experiment tooling stay understandable and verified.

## Context

This support project tracks maintenance work for the workspace itself. Use it for changes to scheduler behavior, Slack operations, project scaffolding, reports, budgets, and experiment tooling.

## Log

### ${today} (Initialized support project)

Created by \`a-exp init\` so workspace-level changes have a durable project log at \`projects/a-exp/README.md\`.

## Open questions

- None yet.
`;
}

function defaultAExpProjectTasks(): string {
  return `# a-exp - Next actions

- [ ] Define workspace maintenance priorities
  Why: The support project needs concrete follow-up tasks once the workspace has an operating goal.
  Done when: \`projects/a-exp/TASKS.md\` contains current bounded tasks for this workspace.
  Priority: medium
`;
}

function defaultApprovalQueue(): string {
  return `# Approval Queue

## Pending

## Completed
`;
}

function defaultGitignore(): string {
  return `.DS_Store
.env
.env.local
__pycache__/
*.pyc
.a-exp/*
!.a-exp/
!.a-exp/config.yaml
!.a-exp/kit.lock.yaml
reports/*.tmp
`;
}
