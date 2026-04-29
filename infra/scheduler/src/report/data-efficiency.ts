/** Efficiency data aggregation — compute findings-per-dollar, waste rate, and trends from session data. */

import type { SessionMetrics, KnowledgeMetrics } from "../metrics.js";
import type { EfficiencySummary, EfficiencyDaySummary } from "./types.js";

const CONTEXT_UTILIZATION_WARNING_THRESHOLD = 0.80;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Count total findings from a KnowledgeMetrics record. Uses newExperimentFindings + logEntryFindings. */
function countFindings(k: KnowledgeMetrics): number {
  return k.newExperimentFindings + k.logEntryFindings;
}

/** Check if all knowledge counts sum to zero. Mirrors isZeroKnowledge in patterns.ts. */
function isZeroKnowledge(k: KnowledgeMetrics): boolean {
  return (
    k.newExperimentFindings === 0 &&
    k.newDecisionRecords === 0 &&
    k.newLiteratureNotes === 0 &&
    (k.openQuestionsResolved ?? 0) === 0 &&
    (k.openQuestionsDiscovered ?? 0) === 0 &&
    k.experimentsCompleted === 0 &&
    (k.crossReferences ?? 0) === 0 &&
    (k.newAnalysisFiles ?? 0) === 0 &&
    (k.logEntryFindings ?? 0) === 0 &&
    (k.infraCodeChanges ?? 0) === 0 &&
    (k.bugfixVerifications ?? 0) === 0 &&
    (k.compoundActions ?? 0) === 0 &&
    (k.structuralChanges ?? 0) === 0 &&
    (k.feedbackProcessed ?? 0) === 0 &&
    (k.diagnosesCompleted ?? 0) === 0
  );
}

/**
 * Check if a session is genuine waste: zero knowledge, no orphan management,
 * low file changes.
 */
function isGenuineWaste(s: SessionMetrics): boolean {
  if (!s.knowledge) return false;
  if (!isZeroKnowledge(s.knowledge)) return false;
  if (s.verification) {
    if ((s.verification.orphanedFiles ?? 0) > 0) return false;
    if ((s.verification.filesChanged ?? 0) >= 50) return false;
    // Sessions with commits and file changes did work, not waste
    if (s.verification.hasCommit && (s.verification.filesChanged ?? 0) > 0) return false;
  }
  return true;
}

/** Check if a session has any knowledge output (non-zero knowledge fields). */
function hasAnyKnowledge(k: KnowledgeMetrics): boolean {
  return !isZeroKnowledge(k);
}

function computeContextUtilization(session: SessionMetrics): number | null {
  if (!session.modelUsage) return null;
  let maxUtilization = 0;
  for (const model of Object.values(session.modelUsage)) {
    if (model.contextWindow && model.contextWindow > 0) {
      maxUtilization = Math.max(maxUtilization, model.inputTokens / model.contextWindow);
    }
  }
  return maxUtilization > 0 ? maxUtilization : null;
}

// ── Main aggregator ────────────────────────────────────────────────────────

/** Aggregate session metrics into an efficiency summary. */
export function aggregateEfficiency(sessions: SessionMetrics[]): EfficiencySummary {
  if (sessions.length === 0) {
    return {
      totalSessions: 0,
      findingsPerDollar: 0,
      avgCostPerFinding: 0,
      avgTurnsPerFinding: 0,
      zeroKnowledgeRate: 0,
      genuineWasteRate: 0,
      highContextUtilizationRate: 0,
      maxContextUtilization: 0,
      byDay: [],
      fleet: null,
    };
  }

  const withKnowledge = sessions.filter((s) => s.knowledge != null);
  const totalCost = sessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  const totalFindings = withKnowledge.reduce((sum, s) => sum + countFindings(s.knowledge!), 0);

  // Findings-per-dollar
  const findingsPerDollar = totalCost > 0 ? totalFindings / totalCost : 0;

  // Cost and turns per finding (only sessions that produced findings)
  const findingSessions = withKnowledge.filter((s) => countFindings(s.knowledge!) > 0);
  let avgCostPerFinding = 0;
  let avgTurnsPerFinding = 0;
  if (findingSessions.length > 0 && totalFindings > 0) {
    const findingCost = findingSessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    avgCostPerFinding = findingCost / totalFindings;

    const turnsPerFinding = findingSessions
      .filter((s) => s.numTurns != null)
      .map((s) => (s.numTurns ?? 0) / countFindings(s.knowledge!));
    if (turnsPerFinding.length > 0) {
      avgTurnsPerFinding = turnsPerFinding.reduce((a, b) => a + b, 0) / turnsPerFinding.length;
    }
  }

  const zeroKCount = withKnowledge.filter((s) => isZeroKnowledge(s.knowledge!)).length;
  const zeroKnowledgeRate = withKnowledge.length > 0
    ? zeroKCount / withKnowledge.length
    : 0;

  // Genuine waste rate
  const genuineWasteCount = sessions.filter(isGenuineWaste).length;
  const genuineWasteRate = sessions.length > 0 ? genuineWasteCount / sessions.length : 0;

  // Context utilization metrics
  const contextUtilizations = sessions
    .map((s) => computeContextUtilization(s))
    .filter((u): u is number => u !== null);
  const highContextCount = contextUtilizations.filter((u) => u >= CONTEXT_UTILIZATION_WARNING_THRESHOLD).length;
  const highContextUtilizationRate = contextUtilizations.length > 0 ? highContextCount / contextUtilizations.length : 0;
  const maxContextUtilization = contextUtilizations.length > 0 ? Math.max(...contextUtilizations) : 0;

  // Group by day
  const dayMap = new Map<string, SessionMetrics[]>();
  for (const s of sessions) {
    const day = s.timestamp.slice(0, 10);
    const arr = dayMap.get(day) ?? [];
    arr.push(s);
    dayMap.set(day, arr);
  }

  const byDay: EfficiencyDaySummary[] = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, daySessions]) => {
      const dayWithK = daySessions.filter((s) => s.knowledge != null);
      const dayFindings = dayWithK.reduce((sum, s) => sum + countFindings(s.knowledge!), 0);
      const dayCost = daySessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
      const dayZeroK = dayWithK.filter((s) => isZeroKnowledge(s.knowledge!)).length;

      return {
        date,
        sessions: daySessions.length,
        totalFindings: dayFindings,
        totalCostUsd: dayCost,
        findingsPerDollar: dayCost > 0 ? dayFindings / dayCost : 0,
        zeroKnowledgeSessions: dayZeroK,
      };
    });

  return {
    totalSessions: sessions.length,
    findingsPerDollar,
    avgCostPerFinding,
    avgTurnsPerFinding,
    zeroKnowledgeRate,
    genuineWasteRate,
    highContextUtilizationRate,
    maxContextUtilization,
    byDay,
    fleet: null,
  };
}
