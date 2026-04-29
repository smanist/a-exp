/** Persistent JSON file store for scheduler jobs. */

import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store, Job, JobCreate, Schedule } from "./types.js";
import { computeNextRunAtMs } from "./schedule.js";

/** Deterministic fingerprint of a schedule for change detection. */
function scheduleFingerprint(s: Schedule): string {
  if (s.kind === "cron") return `cron:${s.expr}`;
  if (s.kind === "every") return `every:${s.everyMs}`;
  return "unknown";
}

const DEFAULT_STORE_PATH = new URL(
  "../../../.scheduler/jobs.json",
  import.meta.url,
).pathname;

function emptyStore(): Store {
  return { version: 1, jobs: [] };
}

type LegacyJobPayload = Job["payload"] & {
  backend?: string;
};

function normalizeLegacyPayload(payload: LegacyJobPayload): Job["payload"] {
  const normalized = { ...payload } as LegacyJobPayload;
  delete normalized.backend;

  return normalized;
}

function normalizeStore(raw: Store): { store: Store; dirty: boolean } {
  let dirty = false;
  const jobs = raw.jobs.map((job) => {
    const payload = normalizeLegacyPayload(job.payload as LegacyJobPayload);
    if ("backend" in (job.payload as LegacyJobPayload)) dirty = true;
    if ("backend" in (job.payload as LegacyJobPayload)) {
      return { ...job, payload };
    }
    return job;
  });
  return {
    store: dirty ? { ...raw, jobs } : raw,
    dirty,
  };
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function emptyState(): Job["state"] {
  return {
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
    runCount: 0,
  };
}

export class JobStore {
  private storePath: string;
  private data: Store | null = null;

  constructor(storePath?: string) {
    this.storePath = storePath ?? DEFAULT_STORE_PATH;
  }

  async load(): Promise<Store> {
    let dirty = false;
    try {
      const raw = await readFile(this.storePath, "utf-8");
      const parsed = JSON.parse(raw) as Store;
      const normalized = normalizeStore(parsed);
      this.data = normalized.store;
      dirty = normalized.dirty;
    } catch {
      // If main file missing, try recovering from .tmp
      const tmpPath = this.storePath + ".tmp";
      try {
        await access(tmpPath);
        const raw = await readFile(tmpPath, "utf-8");
        const parsed = JSON.parse(raw) as Store;
        const normalized = normalizeStore(parsed);
        this.data = normalized.store;
        dirty = normalized.dirty;
        // Promote .tmp to main file
        await rename(tmpPath, this.storePath);
      } catch {
        this.data = emptyStore();
      }
    }
    // Reconcile: recompute nextRunAtMs for enabled jobs whose schedule changed
    if (await this.reconcileSchedules()) {
      dirty = true;
    }
    if (dirty) {
      await this.save();
    }
    return this.data;
  }

  /**
   * Check each enabled job's schedule fingerprint against what was stored.
   * Recompute nextRunAtMs when:
   *   1. Fingerprint doesn't match current schedule (schedule was edited)
   *   2. nextRunAtMs is null (broken job needing healing, regardless of fingerprint)
   * Stamp fingerprint on legacy jobs (no fingerprint, valid nextRunAtMs) without
   * recomputing, so future schedule edits can be detected.
   */
  private async reconcileSchedules(): Promise<boolean> {
    if (!this.data) return false;
    const now = Date.now();
    let dirty = false;
    for (const job of this.data.jobs) {
      if (!job.enabled) continue;
      const fp = scheduleFingerprint(job.schedule);
      const stored = (job.state as any)._scheduleFingerprint as
        | string
        | undefined;
      if (stored === fp && job.state.nextRunAtMs !== null) continue;
      const scheduleEdited = stored !== undefined && stored !== fp;
      if (scheduleEdited || job.state.nextRunAtMs === null) {
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now);
      }
      // Stamp fingerprint (for legacy jobs this is a no-op on nextRunAtMs)
      (job.state as any)._scheduleFingerprint = fp;
      dirty = true;
    }
    return dirty;
  }

  async save(): Promise<void> {
    if (!this.data) return;
    await mkdir(dirname(this.storePath), { recursive: true });
    const tmpPath = this.storePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
    await rename(tmpPath, this.storePath);
  }

  private ensure(): Store {
    if (!this.data) throw new Error("Store not loaded. Call load() first.");
    return this.data;
  }

  list(): Job[] {
    return this.ensure().jobs;
  }

  get(id: string): Job | undefined {
    return this.ensure().jobs.find((j) => j.id === id);
  }

  async add(input: JobCreate): Promise<Job> {
    await this.load();
    const store = this.ensure();
    const now = Date.now();
    const job: Job = {
      id: generateId(),
      name: input.name,
      schedule: input.schedule,
      payload: input.payload,
      enabled: input.enabled ?? true,
      createdAtMs: now,
      state: {
        ...emptyState(),
        nextRunAtMs: computeNextRunAtMs(input.schedule, now),
        _scheduleFingerprint: scheduleFingerprint(input.schedule),
      } as Job["state"],
    };
    store.jobs.push(job);
    await this.save();
    return job;
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const store = this.ensure();
    const idx = store.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    store.jobs.splice(idx, 1);
    await this.save();
    return true;
  }

  async updateState(id: string, patch: Partial<Job["state"]>): Promise<void> {
    await this.load();
    const job = this.get(id);
    if (!job) return;
    Object.assign(job.state, patch);
    await this.save();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.load();
    const job = this.get(id);
    if (!job) return;
    job.enabled = enabled;
    if (enabled) {
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
      (job.state as any)._scheduleFingerprint = scheduleFingerprint(
        job.schedule,
      );
    }
    await this.save();
  }

  getDueJobs(nowMs: number): Job[] {
    return this.ensure().jobs.filter(
      (j) =>
        j.enabled &&
        j.state.nextRunAtMs !== null &&
        j.state.nextRunAtMs <= nowMs,
    );
  }

  getNextWakeMs(): number | null {
    const times = this.ensure()
      .jobs.filter((j) => j.enabled && j.state.nextRunAtMs !== null)
      .map((j) => j.state.nextRunAtMs!);
    return times.length > 0 ? Math.min(...times) : null;
  }
}
