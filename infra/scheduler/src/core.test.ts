import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { setChannelMode, setChannelModesPath } from "./channel-mode.js";
import { setLegacyBackendPreferencePath, setModelPreference, setModelPreferencePath } from "./model-preference.js";
import { computeNextRunAtMs } from "./schedule.js";
import { JobStore } from "./store.js";
import { findWorkspaceRoot, initWorkspace, resolveWorkspace, workspacePaths } from "./workspace.js";

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
    const dir = await mkdtemp(join(tmpdir(), "a-exp-workspace-"));
    try {
      await initWorkspace(dir, "demo");
      const nested = join(dir, "modules", "demo", "src");
      await mkdir(nested, { recursive: true });

      expect(findWorkspaceRoot(nested)).toBe(dir);
      expect(resolveWorkspace({ repo: dir })?.root).toBe(dir);
      expect(resolveWorkspace({ startDir: nested })?.root).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("initializes the project scaffold without overwriting existing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-exp-init-"));
    try {
      const agentsPath = join(dir, "AGENTS.md");
      await writeFile(agentsPath, "custom instructions\n", "utf-8");

      const created = await initWorkspace(dir, "demo");
      expect(created).toContain(".a-exp/config.yaml");
      expect(created).toContain("projects/demo/README.md");
      expect(created).toContain("projects/demo/TASKS.md");
      expect(created).toContain("projects/demo/budget.yaml");
      expect(created).toContain("modules/demo/artifacts/");
      expect(created).toContain("reports/");
      expect(await readFile(agentsPath, "utf-8")).toBe("custom instructions\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps jobs and operator preferences under workspace .a-exp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "a-exp-state-"));
    try {
      await initWorkspace(dir, "demo");
      const paths = workspacePaths(dir);

      const store = new JobStore(paths.jobsPath);
      await store.add({
        name: "test",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { message: "hello", cwd: dir },
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
