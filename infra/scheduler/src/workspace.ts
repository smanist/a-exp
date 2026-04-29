import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export const WORKSPACE_DIR = ".a-exp";
export const LEGACY_STATE_DIR = ".scheduler";
export const CONFIG_PATH = join(WORKSPACE_DIR, "config.yaml");
export const LAYOUT_VERSION = 1;

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
  defaultProject: string;
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

export async function initWorkspace(root: string, project: string): Promise<string[]> {
  const workspace = workspacePaths(root);
  const created: string[] = [];
  const projectDir = join(workspace.root, "projects", project);
  const moduleDir = join(workspace.root, "modules", project);

  await ensureDir(workspace.stateDir, created, workspace.root);
  await ensureFile(
    workspace.configPath,
    `layout_version: ${LAYOUT_VERSION}\ndefault_project: ${project}\n`,
    created,
    workspace.root,
  );
  await ensureFile(
    join(workspace.root, "AGENTS.md"),
    defaultAgents(project),
    created,
    workspace.root,
  );
  await ensureDir(join(projectDir, "plans"), created, workspace.root);
  await ensureDir(join(projectDir, "experiments"), created, workspace.root);
  await ensureFile(
    join(projectDir, "README.md"),
    defaultProjectReadme(project),
    created,
    workspace.root,
  );
  await ensureFile(
    join(projectDir, "TASKS.md"),
    defaultTasks(project),
    created,
    workspace.root,
  );
  await ensureFile(
    join(projectDir, "budget.yaml"),
    defaultBudget(),
    created,
    workspace.root,
  );
  await ensureDir(join(moduleDir, "artifacts"), created, workspace.root);
  await ensureDir(join(workspace.root, "reports"), created, workspace.root);

  return created;
}

async function ensureDir(path: string, created: string[], root: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(path, { recursive: true });
  created.push(relativePath(root, path) + "/");
}

async function ensureFile(path: string, content: string, created: string[], root: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  created.push(relativePath(root, path));
}

function relativePath(root: string, path: string): string {
  return path.slice(root.length + 1);
}

function titleFromProject(project: string): string {
  return project
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ") || project;
}

function defaultAgents(project: string): string {
  return `# AGENTS.md

This repo is an a-exp project workspace. Durable project memory lives in \`projects/${project}/\`; project-owned code and heavy artifacts live in \`modules/${project}/\`.

## Work Cycle

1. Read \`projects/${project}/README.md\` and \`projects/${project}/TASKS.md\`.
2. Select an unblocked task with a concrete \`Done when\`.
3. Make the smallest change that satisfies the task.
4. Verify with the narrowest useful tests or checks.
5. Update the project log with what changed and the exact verification command.
6. Commit the completed logical unit.

## Recording Rules

- Non-obvious discovery -> record it in the project files in the same turn.
- Decision -> record it before relying on it later.
- Experiment -> create or update \`projects/${project}/experiments/<id>/EXPERIMENT.md\`.
- Heavy outputs -> keep them under \`modules/${project}/artifacts/\`.
`;
}

function defaultProjectReadme(project: string): string {
  return `# ${titleFromProject(project)}

Status: active
Priority: medium
Mission: Replace this scaffold with the project mission.
Done when: A final report answers the project question and links to supporting experiment records and artifacts.

## Context

Use this directory for project memory, plans, task decomposition, experiment records, and lightweight budget records. Put project-owned code and heavy outputs under \`modules/${project}/\`.

## Log

### ${new Date().toISOString().slice(0, 10)} (Initialized a-exp workspace)

Created the initial a-exp project scaffold.

Verification:
- Pending first project-specific check.

## Open questions

- What concrete question should this project answer?
`;
}

function defaultTasks(project: string): string {
  return `# ${titleFromProject(project)} - Tasks

- [ ] Define the project question
  Why: The scaffold needs a concrete goal before experiments can be designed.
  Done when: \`projects/${project}/README.md\` has a specific mission and done-when condition.
  Priority: high
`;
}

function defaultBudget(): string {
  return `# Optional lightweight resource and time budget for this project.

resources: {}
`;
}
