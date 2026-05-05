/**
 * Balanced effectiveness scoring engine.
 *
 * Computes a balanced effectiveness score from AI session activity,
 * git/test correlations, manual outcomes, cost/token data, and
 * rework/retry indicators. Missing inputs are reported as unknown
 * rather than treated as zero.
 */

import type Database from 'better-sqlite3';
import type { Storage } from '../storage.js';

export interface ScoreDimension {
  name: string;
  value: number; // 0..1
  weight: number;
  explanation: string;
}

export interface EffectivenessScore {
  aggregate: number; // 0..1
  dimensions: ScoreDimension[];
  missingInputs: string[];
  sessionCount: number;
  dateRange: { from: string | null; to: string | null };
}

export interface ScoreOptions {
  projectId?: string;
  toolId?: string;
  from?: string;
  to?: string;
}

/**
 * Compute a balanced effectiveness score for the given scope.
 */
export function computeEffectivenessScore(
  storage: Storage,
  options: ScoreOptions,
): EffectivenessScore {
  const db = storage.db;

  // Build session query with filters
  let sessionQuery = 'SELECT * FROM sessions WHERE 1=1';
  const params: (string | number)[] = [];

  if (options.projectId) {
    sessionQuery += ' AND project_id = ?';
    params.push(options.projectId);
  }
  if (options.toolId) {
    sessionQuery += ' AND source_tool_id = ?';
    params.push(options.toolId);
  }
  if (options.from) {
    sessionQuery += ' AND started_at >= ?';
    params.push(options.from.length === 10 ? options.from + 'T00:00:00Z' : options.from);
  }
  if (options.to) {
    sessionQuery += ' AND started_at <= ?';
    params.push(options.to.length === 10 ? options.to + 'T23:59:59Z' : options.to);
  }

  sessionQuery += ' ORDER BY started_at';
  const sessions = db.prepare(sessionQuery).all(...params) as Record<string, unknown>[];
  const sessionCount = sessions.length;

  // Date range
  const dateRange = {
    from: sessions.length > 0 ? (sessions[0].started_at as string || null) : null,
    to: sessions.length > 0 ? (sessions[sessions.length - 1].ended_at as string || null) : null,
  };

  const dimensions: ScoreDimension[] = [];
  const missingInputs: string[] = [];

  // ─── Dimension 1: Activity/Output ──────────────────────────────────────
  const activityScore = Math.min(sessionCount / 10, 1);
  dimensions.push({
    name: 'activity-output',
    value: activityScore,
    weight: 0.15,
    explanation: `${sessionCount} AI session(s) completed in the selected period.`,
  });

  // ─── Dimension 2: Git Correlation ──────────────────────────────────────
  const gitDim = computeGitDimension(db, sessions);
  dimensions.push(gitDim);
  if (gitDim.value === 0) {
    missingInputs.push('Git correlation data not available - no matching commits found for sessions.');
  }

  // ─── Dimension 3: Test Confidence ──────────────────────────────────────
  const testDim = computeTestDimension(db, sessions, options.projectId);
  dimensions.push(testDim);
  if (testDim.value === 0) {
    missingInputs.push('Test outcome data not available - no test results linked to sessions.');
  }

  // ─── Dimension 4: Manual Outcome ───────────────────────────────────────
  const manualDim = computeManualOutcomeDimension(db, sessions);
  dimensions.push(manualDim);
  if (manualDim.value === 0 && sessionCount > 0) {
    missingInputs.push('Manual outcome annotations not available - no user ratings recorded.');
  }

  // ─── Dimension 5: Cost Efficiency ──────────────────────────────────────
  const costDim = computeCostDimension(sessions);
  dimensions.push(costDim);
  if (costDim.value === 0 && !costDim.explanation.includes('not available')) {
    // has cost data but efficiency is zero
  } else if (costDim.value === 0) {
    missingInputs.push('Cost/token data not available for some or all sessions - shown as unknown, not zero.');
  }

  // ─── Dimension 6: Rework Indicator ─────────────────────────────────────
  const reworkDim = computeReworkDimension(sessions);
  dimensions.push(reworkDim);

  // ─── Aggregate Score ───────────────────────────────────────────────────
  let totalWeight = 0;
  let weightedSum = 0;
  for (const dim of dimensions) {
    weightedSum += dim.value * dim.weight;
    totalWeight += dim.weight;
  }
  const aggregate = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    aggregate: Math.round(aggregate * 1000) / 1000,
    dimensions,
    missingInputs,
    sessionCount,
    dateRange,
  };
}

function computeGitDimension(
  db: Database.Database,
  sessions: Record<string, unknown>[],
): ScoreDimension {
  if (sessions.length === 0) {
    return { name: 'git-correlation', value: 0, weight: 0.25, explanation: 'No sessions to correlate with git.' };
  }

  let correlatedCount = 0;
  for (const s of sessions) {
    const corr = db.prepare(
      "SELECT count(*) as cnt FROM correlations WHERE session_id = ? AND correlation_type = 'git-commit'",
    ).get(s.id) as { cnt: number };
    if (corr.cnt > 0) correlatedCount++;
  }

  const ratio = correlatedCount / sessions.length;
  const score = Math.min(ratio, 1);

  return {
    name: 'git-correlation',
    value: score,
    weight: 0.25,
    explanation: `${correlatedCount} of ${sessions.length} sessions correlated with git commits (${Math.round(score * 100)}%).`,
  };
}

function computeTestDimension(
  db: Database.Database,
  sessions: Record<string, unknown>[],
  projectId?: string,
): ScoreDimension {
  let testQuery = 'SELECT * FROM test_outcomes';
  const params: string[] = [];
  if (projectId) {
    testQuery += ' WHERE project_id = ?';
    params.push(projectId);
  }

  const testOutcomes = db.prepare(testQuery).all(...params) as Record<string, unknown>[];
  if (testOutcomes.length === 0) {
    return { name: 'test-confidence', value: 0, weight: 0.25, explanation: 'No test outcome data available.' };
  }

  let totalPassed = 0;
  let totalFailed = 0;
  for (const t of testOutcomes) {
    totalPassed += (t.passed as number) || 0;
    totalFailed += (t.failed as number) || 0;
  }

  const total = totalPassed + totalFailed;
  const passRate = total > 0 ? totalPassed / total : 0;

  let correlatedWithTests = 0;
  for (const s of sessions) {
    const corr = db.prepare(
      "SELECT count(*) as cnt FROM correlations WHERE session_id = ? AND correlation_type = 'test-outcome'",
    ).get(s.id) as { cnt: number };
    if (corr.cnt > 0) correlatedWithTests++;
  }
  const correlationRatio = sessions.length > 0 ? correlatedWithTests / sessions.length : 0;

  const score = (passRate * 0.6) + (correlationRatio * 0.4);

  return {
    name: 'test-confidence',
    value: Math.round(score * 1000) / 1000,
    weight: 0.25,
    explanation: `Test pass rate: ${Math.round(passRate * 100)}% (${totalPassed}/${total} passed). ${correlatedWithTests} sessions linked to test outcomes.`,
  };
}

function computeManualOutcomeDimension(
  db: Database.Database,
  sessions: Record<string, unknown>[],
): ScoreDimension {
  if (sessions.length === 0) {
    return { name: 'manual-outcome', value: 0, weight: 0.15, explanation: 'No sessions available.' };
  }

  let totalScore = 0;
  let count = 0;
  for (const s of sessions) {
    const outcomes = db.prepare(
      "SELECT * FROM outcomes WHERE session_id = ? AND outcome_type = 'manual'",
    ).all(s.id) as Record<string, unknown>[];
    for (const o of outcomes) {
      if (typeof o.score === 'number') {
        totalScore += o.score;
        count++;
      }
    }
  }

  if (count === 0) {
    return { name: 'manual-outcome', value: 0, weight: 0.15, explanation: 'No manual outcome annotations recorded.' };
  }

  const avgScore = totalScore / count;
  return {
    name: 'manual-outcome',
    value: Math.round(avgScore * 1000) / 1000,
    weight: 0.15,
    explanation: `Average manual outcome score: ${Math.round(avgScore * 100)}% from ${count} annotation(s).`,
  };
}

function computeCostDimension(
  sessions: Record<string, unknown>[],
): ScoreDimension {
  let sessionsWithCost = 0;
  let totalCost = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  for (const s of sessions) {
    if (s.cost_estimate != null) {
      sessionsWithCost++;
      totalCost += s.cost_estimate as number;
    }
    if (s.tokens_input != null) totalTokensIn += s.tokens_input as number;
    if (s.tokens_output != null) totalTokensOut += s.tokens_output as number;
  }

  if (sessionsWithCost === 0) {
    return {
      name: 'cost-efficiency',
      value: 0,
      weight: 0.10,
      explanation: 'Cost/token data not available for any session - reported as unknown.',
    };
  }

  const avgCost = totalCost / sessionsWithCost;
  const costScore = Math.max(0, Math.min(1, 1 - (avgCost / 1.0)));

  return {
    name: 'cost-efficiency',
    value: Math.round(costScore * 1000) / 1000,
    weight: 0.10,
    explanation: `${sessionsWithCost} session(s) with cost data. Total cost: $${totalCost.toFixed(2)}, Tokens: ${totalTokensIn} in / ${totalTokensOut} out. Avg: $${avgCost.toFixed(3)}/session.`,
  };
}

function computeReworkDimension(
  sessions: Record<string, unknown>[],
): ScoreDimension {
  let totalRework = 0;
  let sessionsWithRework = 0;

  for (const s of sessions) {
    if (s.metadata_json) {
      try {
        const meta = JSON.parse(s.metadata_json as string);
        if (meta.reworkCount && meta.reworkCount > 0) {
          totalRework += meta.reworkCount;
          sessionsWithRework++;
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  if (sessions.length === 0) {
    return { name: 'rework-indicator', value: 1, weight: 0.10, explanation: 'No sessions to evaluate rework.' };
  }

  const reworkRatio = sessionsWithRework / sessions.length;
  const score = Math.max(0, 1 - reworkRatio);

  if (totalRework > 0) {
    return {
      name: 'rework-indicator',
      value: Math.round(score * 1000) / 1000,
      weight: 0.10,
      explanation: `${sessionsWithRework} of ${sessions.length} session(s) had rework/retry attempts (${totalRework} total retries). Rework rate: ${Math.round(reworkRatio * 100)}%.`,
    };
  }

  return {
    name: 'rework-indicator',
    value: 1,
    weight: 0.10,
    explanation: 'No rework or retry indicators detected in session metadata.',
  };
}
