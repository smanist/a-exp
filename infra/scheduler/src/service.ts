/** Scheduler service: timer loop that checks for due jobs and executes them. */

import { JobStore } from "./store.js";
import { computeNextRunAtMs } from "./schedule.js";
import { executeJob, type ExecutionResult } from "./executor.js";
import type { Job } from "./types.js";

export interface ServiceOptions {
  storePath?: string;
  legacyStorePath?: string | null;
  logsDir?: string;
  pollIntervalMs?: number;
  maxConcurrentSessions?: number;
  onBeforeRun?: (job: Job) => boolean | Promise<boolean>;
  onAfterRun?: (job: Job, result: ExecutionResult) => void | Promise<void>;
  onTick?: (dueCount: number) => void | Promise<void>;
}

export class SchedulerService {
  private store: JobStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private pollIntervalMs: number;
  private maxConcurrentSessions: number;
  private runningJobs = new Set<string>();

  constructor(private opts: ServiceOptions = {}) {
    this.store = new JobStore(opts.storePath, opts.legacyStorePath);
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.maxConcurrentSessions = opts.maxConcurrentSessions ?? 1;
  }

  async start(): Promise<void> {
    await this.store.load();
    this.running = true;
    log(`Scheduler started. ${this.store.list().length} jobs loaded.`);
    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch((err) => log(`Tick error: ${err}`));
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log("Scheduler stopped.");
  }

  getStore(): JobStore {
    return this.store;
  }

  getRunningCount(): number {
    return this.runningJobs.size;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    await this.store.load();
    const dueJobs = this.store.getDueJobs(Date.now());
    await this.opts.onTick?.(dueJobs.length);

    for (const job of dueJobs) {
      if (!this.running) break;
      if (this.runningJobs.has(job.name)) continue;
      if (this.maxConcurrentSessions > 0 && this.runningJobs.size >= this.maxConcurrentSessions) {
        log(`Max concurrent sessions (${this.maxConcurrentSessions}) reached, skipping ${job.name}`);
        continue;
      }

      const shouldRun = this.opts.onBeforeRun ? await this.opts.onBeforeRun(job) : true;
      if (!shouldRun) {
        log(`Skipping job ${job.name} (${job.id}): onBeforeRun returned false`);
        continue;
      }

      this.runningJobs.add(job.name);
      await this.store.updateState(job.id, {
        nextRunAtMs: computeNextRunAtMs(job.schedule, Date.now()),
      });

      log(`Executing job: ${job.name} (${job.id})`);
      let result: ExecutionResult;
      try {
        result = await executeJob(job, "scheduler", { logsDir: this.opts.logsDir });
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: 0,
          exitCode: null,
          stdout: "",
          triggerSource: "scheduler",
        };
      } finally {
        this.runningJobs.delete(job.name);
      }

      await this.store.updateState(job.id, {
        lastRunAtMs: Date.now(),
        lastStatus: result.ok ? "ok" : "error",
        lastError: result.error ?? null,
        lastDurationMs: result.durationMs,
        runCount: job.state.runCount + 1,
      });

      log(`Job ${job.name} finished: ${result.ok ? "ok" : "error"} (${Math.round(result.durationMs / 1000)}s)`);
      await this.opts.onAfterRun?.(job, result);
    }
  }
}

function log(msg: string): void {
  console.log(`[scheduler] ${msg}`);
}
