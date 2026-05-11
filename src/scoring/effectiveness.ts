/**
 * Balanced effectiveness scoring engine.
 *
 * Computes a balanced effectiveness score from AI session activity,
 * git/test correlations, manual outcomes, cost/token data, and
 * rework/retry indicators. Missing inputs are reported as unknown
 * rather than treated as zero. Dimensions without available data
 * are excluded from the weighted aggregate denominator.
 */

import type Database from 'better-sqlite3';
import type { Storage } from '../storage.js';
import type { ScoringWeights, ScoringThresholds } from './config.js';
import { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } from './config.js';

const LOW_CONF_THRESHOLD = 0.3;

interface CorrEntry { count: number; maxConfidence: number; totalConfidence: number; }

/**
 * Load correlation counts with confidence details for a set of sessions.
 *
 * Uses SQLite's json_each() to pass session IDs as a JSON array, avoiding
 * the SQLite 999-parameter IN limit and eliminating N+1 per-session queries.
 *
 * Returns Map<sessionId, Map<correlationType, CorrEntry>>.
 */
function loadCorrelationCounts(
  db: Database.Database,
  sessionIds: string[],
  types: string[],
): Map<string, Map<string, CorrEntry>> {
  const result = new Map<string, Map<string, CorrEntry>>();
  if (sessionIds.length === 0 || types.length === 0) return result;

  // Pre-populate so callers can rely on every sessionId being present
  for (const sid of sessionIds) {
    const inner = new Map<string, CorrEntry>();
    for (const t of types) inner.set(t, { count: 0, maxConfidence: 0, totalConfidence: 0 });
    result.set(sid, inner);
  }

  const typePlaceholders = types.map(() => '?').join(', ');
  const sql =
    `SELECT session_id, correlation_type, confidence ` +
    `FROM correlations ` +
    `WHERE session_id IN (SELECT value FROM json_each(?)) ` +
    `AND correlation_type IN (${typePlaceholders})`;

  const rows = db.prepare(sql).all(
    JSON.stringify(sessionIds),
    ...types,
  ) as { session_id: string; correlation_type: string; confidence: number }[];

  for (const row of rows) {
    const inner = result.get(row.session_id);
    if (!inner) continue;
    const conf = row.confidence ?? 0;
    const cur = inner.get(row.correlation_type)!;
    cur.count += 1;
    cur.totalConfidence += conf;
    if (conf > cur.maxConfidence) cur.maxConfidence = conf;
  }

  return result;
}

export interface ScoreDimension {
  name: string;
  value: number; // 0..1
  weight: number;
  explanation: string;
  available: boolean; // whether underlying data exists for this dimension
}

export interface EffectivenessScore {
  aggregate: number; // 0..1
  dimensions: ScoreDimension[];
  missingInputs: string[];
  sessionCount: number;
  dateRange: { from: string | null; to: string | null };
  dataCompleteness: number; // fraction of total weight with available data (0..1)
  evidenceLevel: 'insufficient' | 'partial' | 'strong';
}

export interface ScoreOptions {
  projectId?: string;
  toolId?: string;
  from?: string;
  to?: string;
  /** Custom scoring weights (defaults to DEFAULT_WEIGHTS). */
  weights?: Partial<ScoringWeights>;
  /** Custom scoring thresholds (defaults to DEFAULT_THRESHOLDS). */
  thresholds?: Partial<ScoringThresholds>;
}

/**
 * Compute a balanced effectiveness score for the given scope.
 * Unavailable dimensions are excluded from the weighted denominator
 * so they do not depress the aggregate as zero-valued entries.
 */
export function computeEffectivenessScore(
  storage: Storage,
  options: ScoreOptions,
): EffectivenessScore {
  const db = storage.db;
  const weights: ScoringWeights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const thresholds: ScoringThresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };

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
  const activityScore = Math.min(sessionCount / thresholds.activitySessionCap, 1);
  dimensions.push({
    name: 'activity-output',
    value: activityScore,
    weight: weights['activity-output'],
    explanation: `${sessionCount} AI session(s) completed in the selected period.`,
    available: sessionCount > 0,
  });

  // ─── Pre-load correlation counts (single aggregate query, eliminates N+1) ──
  const sessionIds = sessions.map(s => s.id as string);
  const corrCounts = loadCorrelationCounts(db, sessionIds, ['git-commit', 'test-outcome']);

  // ─── Dimension 2: Git Correlation ──────────────────────────────────────
  const gitDim = computeGitDimension(sessions, corrCounts, weights);
  dimensions.push(gitDim);
  if (!gitDim.available) {
    missingInputs.push('Git correlation data not available - no matching commits found for sessions.');
  }

  // ─── Dimension 3: Test Confidence ──────────────────────────────────────
  const testDim = computeTestDimension(db, sessions, corrCounts, weights);
  dimensions.push(testDim);
  if (!testDim.available) {
    missingInputs.push('Test outcome data not available - no test results linked to sessions.');
  }

  // ─── Dimension 4: Manual Outcome ───────────────────────────────────────
  const manualDim = computeManualOutcomeDimension(db, sessions, weights);
  dimensions.push(manualDim);
  if (!manualDim.available) {
    missingInputs.push('Manual outcome annotations not available - no user ratings recorded.');
  }

  // ─── Dimension 5: Cost Efficiency ──────────────────────────────────────
  const costDim = computeCostDimension(sessions, weights, thresholds);
  dimensions.push(costDim);
  if (!costDim.available) {
    missingInputs.push('Cost/token data not available for some or all sessions - shown as unknown, not zero.');
  }

  // ─── Dimension 6: Rework Indicator ─────────────────────────────────────
  const reworkDim = computeReworkDimension(db, sessions, weights);
  dimensions.push(reworkDim);

  // ─── Aggregate Score ───────────────────────────────────────────────────
  // All dimensions contribute to the denominator; unavailable dims contribute 0
  // to numerator. This prevents a project with only activity+rework data from
  // scoring ~100% by excluding missing dimensions from the denominator.
  const { totalWeightAll, weightedSum, availableWeight } = dimensions.reduce(
    (acc, d) => ({
      totalWeightAll: acc.totalWeightAll + d.weight,
      weightedSum: acc.weightedSum + (d.available ? d.value * d.weight : 0),
      availableWeight: acc.availableWeight + (d.available ? d.weight : 0),
    }),
    { totalWeightAll: 0, weightedSum: 0, availableWeight: 0 },
  );
  const aggregate = totalWeightAll > 0 ? weightedSum / totalWeightAll : 0;
  const dataCompleteness = totalWeightAll > 0 ? availableWeight / totalWeightAll : 0;

  // Check if any "objective" dimension (git, test, manual, pr) has data.
  // pr-outcome included for forward compatibility; dimension wiring lands in later tasks.
  const objectiveAvailable = dimensions.some(
    d => d.available && ['git-correlation', 'test-confidence', 'manual-outcome', 'pr-outcome'].includes(d.name),
  );
  let evidenceLevel: 'insufficient' | 'partial' | 'strong';
  if (!objectiveAvailable || dataCompleteness < 0.4) evidenceLevel = 'insufficient';
  else if (dataCompleteness < 0.7) evidenceLevel = 'partial';
  else evidenceLevel = 'strong';

  return {
    aggregate: Math.round(aggregate * 1000) / 1000,
    dimensions,
    missingInputs,
    sessionCount,
    dateRange,
    dataCompleteness: Math.round(dataCompleteness * 1000) / 1000,
    evidenceLevel,
  };
}

function computeGitDimension(
  sessions: Record<string, unknown>[],
  corrCounts: Map<string, Map<string, CorrEntry>>,
  weights: ScoringWeights,
): ScoreDimension {
  if (sessions.length === 0) {
    return { name: 'git-correlation', value: 0, weight: weights['git-correlation'], explanation: 'No sessions to correlate with git.', available: false };
  }

  let confidenceSum = 0;
  let qualifying = 0;
  for (const s of sessions) {
    const entry = corrCounts.get(s.id as string)?.get('git-commit');
    if (!entry || entry.maxConfidence < LOW_CONF_THRESHOLD) continue;
    confidenceSum += Math.min(entry.maxConfidence, 1);
    qualifying++;
  }

  const ratio = sessions.length > 0 ? confidenceSum / sessions.length : 0;
  const score = Math.min(ratio, 1);
  const hasData = qualifying > 0;

  return {
    name: 'git-correlation',
    value: score,
    weight: weights['git-correlation'],
    explanation: `${qualifying} of ${sessions.length} sessions correlated with git commits (confidence-weighted: ${Math.round(score * 100)}%).`,
    available: hasData,
  };
}

function computeTestDimension(
  db: Database.Database,
  sessions: Record<string, unknown>[],
  corrCounts: Map<string, Map<string, CorrEntry>>,
  weights: ScoringWeights,
): ScoreDimension {
  const sessionIds = sessions.map(s => s.id as string);
  if (sessionIds.length === 0) {
    return {
      name: 'test-confidence',
      value: 0,
      weight: weights['test-confidence'],
      explanation: 'No sessions matched the filter - test confidence not available.',
      available: false,
    };
  }

  const placeholders = sessionIds.map(() => '?').join(',');
  const filteredTestOutcomes = db.prepare(
    `SELECT * FROM test_outcomes
     WHERE session_id IN (${placeholders})
        OR id IN (
           SELECT target_id FROM correlations
           WHERE correlation_type = 'test-outcome' AND session_id IN (${placeholders})
        )`,
  ).all(...sessionIds, ...sessionIds) as Record<string, unknown>[];

  if (filteredTestOutcomes.length === 0) {
    return {
      name: 'test-confidence', value: 0, weight: weights['test-confidence'],
      explanation: 'No test outcomes linked to the filtered sessions.',
      available: false,
    };
  }

  let totalPassed = 0;
  let totalFailed = 0;
  for (const t of filteredTestOutcomes) {
    totalPassed += (t.passed as number) || 0;
    totalFailed += (t.failed as number) || 0;
  }

  const total = totalPassed + totalFailed;
  const passRate = total > 0 ? totalPassed / total : 0;

  let testConfidenceSum = 0;
  let testQualifying = 0;
  for (const s of sessions) {
    const entry = corrCounts.get(s.id as string)?.get('test-outcome');
    if (!entry || entry.maxConfidence < LOW_CONF_THRESHOLD) continue;
    testConfidenceSum += Math.min(entry.maxConfidence, 1);
    testQualifying++;
  }
  const correlationRatio = sessions.length > 0 ? testConfidenceSum / sessions.length : 0;

  const score = (passRate * 0.6) + (correlationRatio * 0.4);

  return {
    name: 'test-confidence',
    value: Math.round(score * 1000) / 1000,
    weight: weights['test-confidence'],
    explanation: 'Test pass rate: ' + Math.round(passRate * 100) + '% (' + totalPassed + '/' + total + ' passed). ' + testQualifying + ' sessions linked to test outcomes.',
    available: true,
  };
}

function computeManualOutcomeDimension(
  db: Database.Database,
  sessions: Record<string, unknown>[],
  weights: ScoringWeights,
): ScoreDimension {
  if (sessions.length === 0) {
    return { name: 'manual-outcome', value: 0, weight: weights['manual-outcome'], explanation: 'No sessions available.', available: false };
  }

  // Single aggregate query using SQLite JSON1 — avoids N+1 per-session SELECTs.
  // Passes session IDs as a JSON array so we are not bound by SQLite's
  // 999-parameter IN limit for large session sets.
  const sessionIds = sessions.map(s => s.id as string);
  const row = db.prepare(
    "SELECT COALESCE(SUM(score), 0) AS total_score, COUNT(score) AS cnt " +
    "FROM outcomes " +
    "WHERE session_id IN (SELECT value FROM json_each(?)) " +
    "AND outcome_type = 'manual' " +
    "AND score IS NOT NULL"
  ).get(JSON.stringify(sessionIds)) as { total_score: number | null; cnt: number | null };

  const totalScore = row.total_score ?? 0;
  const count = row.cnt ?? 0;

  if (count === 0) {
    return { name: 'manual-outcome', value: 0, weight: weights['manual-outcome'], explanation: 'No manual outcome annotations recorded.', available: false };
  }

  const avgScore = totalScore / count;
  return {
    name: 'manual-outcome',
    value: Math.round(avgScore * 1000) / 1000,
    weight: weights['manual-outcome'],
    explanation: `Average manual outcome score: ${Math.round(avgScore * 100)}% from ${count} annotation(s).`,
    available: true,
  };
}

function computeCostDimension(
  sessions: Record<string, unknown>[],
  weights: ScoringWeights,
  thresholds: ScoringThresholds,
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
      weight: weights['cost-efficiency'],
      explanation: 'Cost/token data not available for any session - reported as unknown.',
      available: false,
    };
  }

  const avgCost = totalCost / sessionsWithCost;
  const costScore = Math.max(0, Math.min(1, 1 - (avgCost / thresholds.costCeiling)));

  return {
    name: 'cost-efficiency',
    value: Math.round(costScore * 1000) / 1000,
    weight: weights['cost-efficiency'],
    explanation: `${sessionsWithCost} session(s) with cost data. Total cost: $${totalCost.toFixed(2)}, Tokens: ${totalTokensIn} in / ${totalTokensOut} out. Avg: $${avgCost.toFixed(3)}/session.`,
    available: true,
  };
}

function computeReworkDimension(
  db: Database.Database,
  sessions: Record<string, unknown>[],
  weights: ScoringWeights,
): ScoreDimension {
  if (sessions.length === 0) {
    return { name: 'rework-indicator', value: 1, weight: weights['rework-indicator'], explanation: 'No sessions to evaluate rework.', available: false };
  }

  const sessionIds = sessions.map(s => s.id as string);

  // Single aggregate query using SQLite JSON1 — avoids per-session JSON.parse
  // and surfaces malformed metadata_json rows that were previously silently ignored.
  const sql = `
    SELECT
      SUM(CASE WHEN rework > 0 THEN 1 ELSE 0 END) AS sessions_with_rework,
      SUM(rework) AS total_rework,
      SUM(CASE WHEN metadata_json IS NOT NULL AND json_valid(metadata_json) = 0 THEN 1 ELSE 0 END) AS invalid_json_count
    FROM (
      SELECT
        CASE WHEN json_valid(metadata_json) = 1
             THEN COALESCE(CAST(json_extract(metadata_json, '$.reworkCount') AS INTEGER), 0)
             ELSE 0
        END AS rework,
        metadata_json
      FROM sessions
      WHERE id IN (SELECT value FROM json_each(?))
    )
  `;

  const row = db.prepare(sql).get(JSON.stringify(sessionIds)) as {
    sessions_with_rework: number | null;
    total_rework: number | null;
    invalid_json_count: number | null;
  };

  const sessionsWithRework = row.sessions_with_rework ?? 0;
  const totalRework = row.total_rework ?? 0;
  const invalidJsonCount = row.invalid_json_count ?? 0;

  // All-malformed case: every session has unparseable metadata — no rework
  // signal can be derived, so report the dimension as unavailable. A mixed
  // batch (some malformed, some valid) still yields a usable signal from
  // the valid subset; we just surface the malformed count in the explanation.
  if (invalidJsonCount > 0 && invalidJsonCount === sessions.length) {
    return {
      name: 'rework-indicator',
      value: 1,
      weight: weights['rework-indicator'],
      explanation: `All ${invalidJsonCount} session(s) had unparseable metadata; rework signal unavailable.`,
      available: false,
    };
  }

  const reworkRatio = sessionsWithRework / sessions.length;
  const score = Math.max(0, 1 - reworkRatio);
  const malformedNote = invalidJsonCount > 0 ? ` (${invalidJsonCount} session(s) had unparseable metadata)` : '';

  if (totalRework > 0) {
    return {
      name: 'rework-indicator',
      value: Math.round(score * 1000) / 1000,
      weight: weights['rework-indicator'],
      explanation: `${sessionsWithRework} of ${sessions.length} session(s) had rework/retry attempts (${totalRework} total retries). Rework rate: ${Math.round(reworkRatio * 100)}%.${malformedNote}`,
      available: true,
    };
  }

  return {
    name: 'rework-indicator',
    value: 1,
    weight: weights['rework-indicator'],
    explanation: `No rework or retry indicators detected in session metadata.${malformedNote}`,
    available: true,
  };
}
