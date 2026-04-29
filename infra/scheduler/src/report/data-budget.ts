/** Budget data reader — wraps existing readAllBudgetStatuses with burn rate projections. */

import { readAllBudgetStatuses, readBudgetStatus } from "../notify.js";
import { EXCLUDED_PROJECTS } from "../constants.js";
import type { BudgetSummary } from "./types.js";

/** Read all project budgets and compute burn rate projections. */
export async function readBudgets(repoDir: string): Promise<BudgetSummary[]> {
  const statuses = await readAllBudgetStatuses(repoDir, EXCLUDED_PROJECTS);
  return statuses.map(({ project, status }) => toBudgetSummary(project, status));
}

/** Read budget for a single project. Returns null if no budget.yaml exists. */
export async function readProjectBudget(
  projectDir: string,
  projectName: string,
): Promise<BudgetSummary | null> {
  const status = await readBudgetStatus(projectDir);
  if (!status) return null;
  return toBudgetSummary(projectName, status);
}

function toBudgetSummary(
  project: string,
  status: { resources: { resource: string; consumed: number; limit: number; unit: string; pct: number }[]; deadline?: string; hoursToDeadline?: number },
): BudgetSummary {
  // Estimate projected exhaustion from burn rate
  let projectedExhaustion: string | null = null;
  if (status.deadline && status.hoursToDeadline != null) {
    // Use hours to deadline and consumption rate to project
    const now = Date.now();
    const deadlineMs = now + status.hoursToDeadline * 3600 * 1000;
    const totalHours = (deadlineMs - now) / (3600 * 1000) + (status.hoursToDeadline > 0 ? 0 : Math.abs(status.hoursToDeadline));

    for (const r of status.resources) {
      if (r.consumed > 0 && r.limit > 0 && r.pct < 100) {
        // Simple linear projection: at current rate, when will limit be hit?
        // We don't know when consumption started, so use a rough heuristic:
        // assume consumption has been roughly uniform over the elapsed period
        const remaining = r.limit - r.consumed;
        const burnRatePerHour = totalHours > 0 ? r.consumed / Math.max(totalHours, 1) : 0;
        if (burnRatePerHour > 0) {
          const hoursToExhaustion = remaining / burnRatePerHour;
          const exhaustionDate = new Date(now + hoursToExhaustion * 3600 * 1000);
          projectedExhaustion = exhaustionDate.toISOString().slice(0, 10);
        }
      }
    }
  }

  return {
    project,
    resources: status.resources,
    deadline: status.deadline,
    hoursToDeadline: status.hoursToDeadline,
    projectedExhaustion,
  };
}
