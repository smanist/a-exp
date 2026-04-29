import * as fs from 'fs';
import * as path from 'path';

export interface InstanceCheckResult {
  canStart: boolean;
  existingPid?: number;
  message: string;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

export function checkForExistingInstance(lockfilePath: string): InstanceCheckResult {
  if (!fs.existsSync(lockfilePath)) {
    return { canStart: true, message: 'No existing lockfile found' };
  }

  let pid: number;
  try {
    const content = fs.readFileSync(lockfilePath, 'utf-8').trim();
    pid = parseInt(content, 10);
    if (isNaN(pid)) {
      return { canStart: true, message: 'Invalid PID in lockfile, will overwrite' };
    }
  } catch {
    return { canStart: true, message: 'Failed to read lockfile, will overwrite' };
  }

  if (!isPidAlive(pid)) {
    return { canStart: true, existingPid: pid, message: `Previous instance (PID ${pid}) is no longer running` };
  }

  return {
    canStart: false,
    existingPid: pid,
    message: `Another scheduler instance is already running with PID ${pid}. Refusing to start to prevent conflicts.`,
  };
}

export function getDaemonStateFromLockfile(lockfilePath: string): 'running' | 'stopped' {
  if (!fs.existsSync(lockfilePath)) return 'stopped';
  try {
    const pid = parseInt(fs.readFileSync(lockfilePath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return 'stopped';
    return isPidAlive(pid) ? 'running' : 'stopped';
  } catch {
    return 'stopped';
  }
}

export function acquireLock(lockfilePath: string): void {
  const dir = path.dirname(lockfilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(lockfilePath, process.pid.toString());
}

export function releaseLock(lockfilePath: string): void {
  try {
    if (fs.existsSync(lockfilePath)) {
      const content = fs.readFileSync(lockfilePath, 'utf-8').trim();
      const storedPid = parseInt(content, 10);
      if (!isNaN(storedPid) && storedPid === process.pid) {
        fs.unlinkSync(lockfilePath);
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

export function getSchedulerLockfilePath(schedulerDir: string): string {
  return path.join(schedulerDir, 'scheduler.pid');
}
