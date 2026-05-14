import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { consumeCodexExecJsonMessage, createCodexExecJsonState, finalizeCodexExecJsonState, getBackend, parseCodexMessage } from "./backend.js";
import { setChannelMode, setChannelModesPath } from "./channel-mode.js";
import {
  PROJECT_DESCRIPTION_TEMPLATE,
  buildSchedulerAddInput,
  buildDeterministicKanbanArgs,
  buildKanbanSkillPrompt,
  buildPacketSkillPrompt,
  buildProjectSkillPrompt,
  buildStartForegroundArgs,
  createProjectDescriptionTempFile,
  formatAddedJob,
  parseProjectDescriptionFile,
  stopScheduler,
} from "./cli.js";
import { executeJob } from "./executor.js";
import { getDaemonStateFromLockfile } from "./instance-guard.js";
import { setLegacyBackendPreferencePath, setModelPreference, setModelPreferencePath } from "./model-preference.js";
import { parseProjectReadme } from "./report/data-projects.js";
import { computeNextRunAtMs } from "./schedule.js";
import { JobStore } from "./store.js";
import { findWorkspaceRoot, initWorkspace, parseWorkspaceConfig, resolveWorkspace, workspacePaths } from "./workspace.js";

async function makeSiblingWorkspace(prefix: string): Promise<{ parent: string; repo: string }> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const kit = join(parent, "a-exp");
  const repo = join(parent, "demo-repo");
  await mkdir(join(kit, ".agents", "skills"), { recursive: true });
  await mkdir(join(kit, "docs"), { recursive: true });
  await mkdir(repo, { recursive: true });
  return { parent, repo };
}

describe("a-exp core scheduler", () => {
  it("computes future interval schedules", () => {
    const next = computeNextRunAtMs({ kind: "every", everyMs: 60_000, anchorMs: 1_000 }, 61_000);
    expect(next).toBe(121_000);
  });

  it("persists jobs with repo-local state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-exp-store-"));
    try {
      const path = join(dir, "jobs.json");
      const store = new JobStore(path);
      const job = await store.add({
        name: "test",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { message: "hello", cwd: dir },
      });

      const reloaded = new JobStore(path);
      await reloaded.load();
      expect(reloaded.get(job.id)?.name).toBe("test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers initialized workspaces from nested directories and explicit repo paths", async () => {
    const { parent, repo } = await makeSiblingWorkspace("a-exp-workspace-");
    try {
      await initWorkspace(repo, "demo");
      const nested = join(repo, "modules", "demo", "src");
      await mkdir(nested, { recursive: true });

      expect(findWorkspaceRoot(nested)).toBe(repo);
      expect(resolveWorkspace({ repo })?.root).toBe(repo);
      expect(resolveWorkspace({ startDir: nested })?.root).toBe(repo);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("initializes the project scaffold without overwriting existing files", async () => {
    const { parent, repo } = await makeSiblingWorkspace("a-exp-init-");
    try {
      const agentsPath = join(repo, "AGENTS.md");
      await writeFile(agentsPath, "custom instructions\n", "utf-8");

      const created = await initWorkspace(repo, "demo");
      expect(created).toContain(".a-exp/config.yaml");
      expect(created).toContain(".a-exp/kit.lock.yaml");
      expect(created).toContain(".gitignore");
      expect(created).toContain(".agents -> ../a-exp/.agents");
      expect(created).toContain("docs -> ../a-exp/docs");
      expect(created).toContain("projects/demo/README.md");
      expect(created).toContain("projects/demo/TASKS.md");
      expect(created).toContain("projects/demo/budget.yaml");
      expect(created).toContain("projects/demo/ledger.yaml");
      expect(created).toContain("projects/demo/plans/.gitkeep");
      expect(created).toContain("projects/demo/experiments/.gitkeep");
      expect(created).toContain("modules/registry.yaml");
      expect(created).toContain("modules/demo/artifacts/");
      expect(created).toContain("modules/demo/artifacts/.gitkeep");
      expect(created).toContain("reports/");
      expect(created).toContain("reports/.gitkeep");
      expect(created).toContain("APPROVAL_QUEUE.md");
      expect(await readFile(agentsPath, "utf-8")).toBe("custom instructions\n");
      expect(await readlink(join(repo, ".agents"))).toBe("../a-exp/.agents");
      expect(await readlink(join(repo, "docs"))).toBe("../a-exp/docs");
      const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf-8" }).trim();
      expect(await realpath(gitRoot)).toBe(await realpath(repo));
      expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf-8" }).trim()).toBe("Initialize a-exp workspace for demo");
      expect(execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf-8" }).trim()).toBe("?? AGENTS.md");
      const config = parseWorkspaceConfig(await readFile(join(repo, ".a-exp", "config.yaml"), "utf-8"));
      expect(config.scheduler?.addDefaults).toMatchObject({
        name: "work-cycle",
        cron: "0 * * * *",
        messageDefault: true,
        model: "strong",
        cwd: ".",
        maxDurationMs: 1_800_000,
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("builds add jobs from workspace scheduler defaults with CLI overrides", () => {
    const workspace = workspacePaths("/repo");
    const input = buildSchedulerAddInput(
      { model: "frontier", every: "60000" },
      workspace,
      {
        name: "work-cycle",
        cron: "0 * * * *",
        messageDefault: true,
        model: "strong",
        cwd: ".",
        maxDurationMs: 1_800_000,
      },
    );

    expect(input.name).toBe("work-cycle");
    expect(input.schedule.kind).toBe("every");
    expect(input.schedule.kind === "every" ? input.schedule.everyMs : null).toBe(60_000);
    expect(input.payload.model).toBe("frontier");
    expect(input.payload.cwd).toBe("/repo");
    expect(input.payload.maxDurationMs).toBe(1_800_000);
    expect(input.payload.message).toContain("Run one a-exp work cycle.");
  });

  it("treats add positional shorthand as project name and project prompt", () => {
    const workspace = workspacePaths("/repo");
    const input = buildSchedulerAddInput(
      {},
      workspace,
      {
        name: "work-cycle",
        cron: "0 * * * *",
        messageDefault: true,
        model: "strong",
      },
      "demo",
    );

    expect(input.name).toBe("demo");
    expect(input.schedule.kind).toBe("cron");
    expect(input.payload.model).toBe("strong");
    expect(input.payload.message).toContain("projects/demo");
  });

  it("formats added job details", () => {
    const output = formatAddedJob({
      id: "job_123",
      name: "demo",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "America/New_York" },
      payload: {
        message: "Run one a-exp work cycle scoped to projects/demo.\nRead the project README and TASKS.",
        model: "strong",
        cwd: "/repo",
        maxDurationMs: 1_800_000,
      },
      enabled: true,
      createdAtMs: 0,
      state: {
        nextRunAtMs: 1_800_000,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    });

    expect(output).toContain("Added job demo (job_123)");
    expect(output).toContain("Cron: 0 * * * *");
    expect(output).toContain("Timezone: America/New_York");
    expect(output).toContain("Model: strong");
    expect(output).toContain("Project: demo");
    expect(output).toContain("Cwd: /repo");
    expect(output).toContain("Max duration: 1800000ms");
    expect(output).toContain("Enabled: yes");
    expect(output).toContain("Next run: 1970-01-01T00:30:00.000Z");
  });

  it("parses report tasks without treating multi-bullet Done when criteria as tasks", () => {
    const parsed = parseProjectReadme(
      `# Demo

Status: active
Mission: Test report parsing.
Done when: Reports stay readable.

## Next actions

- [ ] Ship a mid-sized task
  Why: The task has multiple acceptance checks.
  Done when:
  - [ ] Build passes.
  - [ ] Report output contains one open task.
  Priority: high
`,
      "demo",
    );

    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].text).toBe("Ship a mid-sized task");
  });

  it("parses project description files with scaffold as the default mode", () => {
    const description = parseProjectDescriptionFile(
      [
        "Title: Calibration Study",
        "Mode: scaffold (default; or augment, etc.)",
        "",
        "Investigate whether calibration reduces rollout error.",
        "Done when a report compares two methods.",
      ].join("\n"),
    );

    expect(description).toEqual({
      title: "Calibration Study",
      mode: "scaffold",
      project: undefined,
      content: "Investigate whether calibration reduces rollout error.\nDone when a report compares two methods.",
    });
  });

  it("builds a project skill prompt from a description file", () => {
    const prompt = buildProjectSkillPrompt(
      {
        title: "Add Dataset Baselines",
        mode: "augment",
        project: "sysid",
        content: "Add benchmark tasks for the new datasets.",
      },
      "/tmp/project-description.md",
    );

    expect(prompt).toContain("Use the project skill in augment mode");
    expect(prompt).toContain("description file at /tmp/project-description.md");
    expect(prompt).toContain("Treat the description file as human-provided project input");
    expect(prompt).toContain("Title: Add Dataset Baselines");
    expect(prompt).toContain("Project: sysid");
    expect(prompt).toContain("Add benchmark tasks for the new datasets.");
  });

  it("creates a VS Code-editable project description temp file", async () => {
    const path = createProjectDescriptionTempFile();
    const content = await readFile(path, "utf-8");

    expect(content).toBe(PROJECT_DESCRIPTION_TEMPLATE);
    expect(parseProjectDescriptionFile(content)).toEqual({
      title: undefined,
      mode: "scaffold",
      project: undefined,
      content: "Describe the project or scope change here. Include useful context, done-when criteria, and task granularity preferences.",
    });
  });

  it("builds a kanban skill prompt from CLI options", () => {
    const prompt = buildKanbanSkillPrompt({
      project: "a-exp",
      outputDir: "reports/kanban",
      maxCostItems: "2",
      maxResultBullets: "3",
    });

    expect(prompt).toContain("Use the kanban skill");
    expect(prompt).toContain("Project: a-exp");
    expect(prompt).toContain("Output directory: reports/kanban");
    expect(prompt).toContain("Max cost items: 2");
    expect(prompt).toContain("Max result bullets: 3");
  });

  it("builds deterministic kanban generator arguments", () => {
    expect(buildDeterministicKanbanArgs("/repo", {
      project: "a-exp",
      outputDir: "reports/kanban",
      maxCostItems: "2",
      maxResultBullets: "3",
      dryRun: true,
      singleOutput: "_quick.md",
    })).toEqual([
      "/repo/.agents/skills/kanban/scripts/generate_kanban.py",
      "--repo-root",
      "/repo",
      "a-exp",
      "--output-dir",
      "reports/kanban",
      "--max-cost-items",
      "2",
      "--max-result-bullets",
      "3",
      "--single-output",
      "_quick.md",
      "--dry-run",
    ]);
  });

  it("builds a packet skill prompt from CLI arguments", () => {
    const prompt = buildPacketSkillPrompt({
      project: "solver",
      targetPackage: "/tmp/target-package",
      instructions: "Prefer the existing linear algebra API.",
    });

    expect(prompt).toContain("Use the packet skill");
    expect(prompt).toContain("Project: solver");
    expect(prompt).toContain("Target package: /tmp/target-package");
    expect(prompt).toContain("Prefer the existing linear algebra API.");
    expect(prompt).toContain("reports/packet/");
  });

  it("builds foreground start arguments for daemon handoff", () => {
    expect(buildStartForegroundArgs("/repo/a-exp/infra/scheduler/dist/cli.js", "/workspace")).toEqual([
      "/repo/a-exp/infra/scheduler/dist/cli.js",
      "--repo",
      "/workspace",
      "start",
      "--foreground",
    ]);
  });

  it("requires non-self-hosting workspaces to be parallel to an a-exp kit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-exp-no-kit-"));
    try {
      await expect(initWorkspace(dir, "demo")).rejects.toThrow(/a-exp kit not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps jobs and operator preferences under workspace .a-exp", async () => {
    const { parent, repo } = await makeSiblingWorkspace("a-exp-state-");
    try {
      await initWorkspace(repo, "demo");
      const paths = workspacePaths(repo);

      const store = new JobStore(paths.jobsPath);
      await store.add({
        name: "test",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { message: "hello", cwd: repo },
      });
      expect(JSON.parse(await readFile(paths.jobsPath, "utf-8")).jobs).toHaveLength(1);

      setChannelModesPath(paths.channelModesPath);
      await setChannelMode("C123", "chat", "research");
      expect(await readFile(paths.channelModesPath, "utf-8")).toContain("C123");

      setModelPreferencePath(paths.modelPreferencePath);
      setLegacyBackendPreferencePath(paths.legacyBackendPreferencePath);
      await setModelPreference("gpt-5.2");
      expect(await readFile(paths.modelPreferencePath, "utf-8")).toContain("gpt-5.2");

      setChannelModesPath(null);
      setModelPreferencePath(null);
      setLegacyBackendPreferencePath(null);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("reports daemon state from the workspace lockfile", async () => {
    const { parent, repo } = await makeSiblingWorkspace("a-exp-daemon-");
    try {
      await initWorkspace(repo, "demo");
      const paths = workspacePaths(repo);
      const lockfile = join(paths.lockDir, "scheduler.pid");
      expect(getDaemonStateFromLockfile(lockfile)).toBe("stopped");

      await writeFile(lockfile, `${process.pid}\n`, "utf-8");
      expect(getDaemonStateFromLockfile(lockfile)).toBe("running");

      await writeFile(lockfile, "999999999\n", "utf-8");
      expect(getDaemonStateFromLockfile(lockfile)).toBe("stopped");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("removes stale scheduler lockfiles on stop", async () => {
    const { parent, repo } = await makeSiblingWorkspace("a-exp-stale-stop-");
    try {
      await initWorkspace(repo, "demo");
      const paths = workspacePaths(repo);
      const lockfile = join(paths.lockDir, "scheduler.pid");
      await writeFile(lockfile, "999999999\n", "utf-8");

      const result = await stopScheduler(repo);

      expect(result.message).toBe("Removed stale scheduler lockfile");
      await expect(readFile(lockfile, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("marks Codex JSON error events as failed results", () => {
    const errorState = createCodexExecJsonState();
    consumeCodexExecJsonMessage(errorState, { type: "error", message: "startup failed" });
    expect(finalizeCodexExecJsonState(errorState)).toMatchObject({
      ok: false,
      text: "startup failed",
    });

    const failedTurnState = createCodexExecJsonState();
    consumeCodexExecJsonMessage(failedTurnState, { type: "turn.failed", error: { message: "turn crashed" } });
    expect(finalizeCodexExecJsonState(failedTurnState)).toMatchObject({
      ok: false,
      text: "turn crashed",
    });

    expect(parseCodexMessage(JSON.stringify({ type: "turn.failed", error: { message: "turn crashed" } }))).toMatchObject({
      type: "result",
      is_error: true,
      result: "turn crashed",
    });
  });

  it("rejects non-zero Codex exits even when stderr has output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-exp-codex-fail-"));
    const oldCodexBin = process.env["CODEX_BIN"];
    try {
      const bin = join(dir, "fake-codex.js");
      await writeFile(
        bin,
        "#!/usr/bin/env node\nprocess.stderr.write('startup denied\\n');\nprocess.exit(2);\n",
        "utf-8",
      );
      await chmod(bin, 0o755);
      process.env["CODEX_BIN"] = bin;

      await expect(getBackend("codex").runQuery({ prompt: "hello", cwd: dir })).rejects.toThrow(
        /codex exited with code 2: startup denied/,
      );
    } finally {
      if (oldCodexBin === undefined) delete process.env["CODEX_BIN"];
      else process.env["CODEX_BIN"] = oldCodexBin;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks scheduled jobs failed when Codex emits a JSON error event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-exp-codex-json-error-"));
    const oldCodexBin = process.env["CODEX_BIN"];
    try {
      const bin = join(dir, "fake-codex.js");
      await writeFile(
        bin,
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'error', message: 'startup failed' }) + '\\n');\n",
        "utf-8",
      );
      await chmod(bin, 0o755);
      process.env["CODEX_BIN"] = bin;

      const result = await executeJob(
        {
          id: "codex-json-error",
          name: "codex-json-error",
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { message: "hello", cwd: dir, maxDurationMs: 1_000 },
          enabled: true,
          createdAtMs: Date.now(),
          state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, lastError: null, lastDurationMs: null, runCount: 0 },
        },
        "manual",
        { logsDir: join(dir, "logs") },
      );

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toBe("startup failed");
    } finally {
      if (oldCodexBin === undefined) delete process.env["CODEX_BIN"];
      else process.env["CODEX_BIN"] = oldCodexBin;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("imports legacy scheduler jobs only when an explicit legacy path is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-exp-legacy-"));
    try {
      const legacyJobs = join(dir, ".scheduler", "jobs.json");
      await mkdir(join(dir, ".scheduler"), { recursive: true });
      await writeFile(
        legacyJobs,
        JSON.stringify({
          version: 1,
          jobs: [{
            id: "legacy",
            name: "legacy",
            schedule: { kind: "every", everyMs: 60_000 },
            payload: { message: "legacy", cwd: dir },
            enabled: true,
            createdAtMs: 1,
            state: { nextRunAtMs: null, lastRunAtMs: null, lastStatus: null, lastError: null, lastDurationMs: null, runCount: 0 },
          }],
        }),
        "utf-8",
      );

      const paths = workspacePaths(dir);
      const store = new JobStore(paths.jobsPath, legacyJobs);
      await store.load();
      expect(store.get("legacy")?.name).toBe("legacy");
      expect(JSON.parse(await readFile(paths.jobsPath, "utf-8")).jobs).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
