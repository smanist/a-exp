import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { computeNextRunAtMs } from "./schedule.js";
import { JobStore } from "./store.js";

describe("OpenAkari core scheduler", () => {
  it("computes future interval schedules", () => {
    const next = computeNextRunAtMs({ kind: "every", everyMs: 60_000, anchorMs: 1_000 }, 61_000);
    expect(next).toBe(121_000);
  });

  it("persists jobs with repo-local state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "akari-store-"));
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
});
