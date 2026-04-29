import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { setChannelMode, setChannelModesPath } from "./channel-mode.js";
import { getDaemonStateFromLockfile } from "./instance-guard.js";
import { setLegacyBackendPreferencePath, setModelPreference, setModelPreferencePath } from "./model-preference.js";
import { computeNextRunAtMs } from "./schedule.js";
import { JobStore } from "./store.js";
import { findWorkspaceRoot, initWorkspace, resolveWorkspace, workspacePaths } from "./workspace.js";

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
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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
