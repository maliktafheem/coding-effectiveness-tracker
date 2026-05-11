/**
 * Trend analytics — computes rolling-period effectiveness trends.
 *
 * Produces weekly aggregated data for session count, test outcomes,
 * and score components for use in dashboard charts and CLI output.
 */

import type { Storage } from '../storage.js';
import { computeEffectivenessScore } from '../scoring/effectiveness.js';
import { loadScoringConfig, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } from '../scoring/config.js';
import type { ScoringConfig } from '../scoring/config.js';

export interface TrendPoint {
  weekStart: string;
  weekEnd: string;
  sessionCount: number;
  sessionsWithGit: number;
  totalTestsPassed: number;
  totalTestsFailed: number;
  scoreAggregate: number;
}

export interface TrendData {
  points: TrendPoint[];
  period: { from: string | null; to: string | null };
}

/**
 * Compute weekly trend data from sessions and test outcomes.
 * Groups sessions by ISO week and aggregates per-week metrics.
 */
export function computeTrends(storage: Storage, projectId?: string, dataDir?: string): TrendData {
  const db = storage.db;

  // Load scoring config so every per-window call gets the same weights + thresholds
  const cfg: ScoringConfig = dataDir ? loadScoringConfig(dataDir) : { weights: { ...DEFAULT_WEIGHTS }, thresholds: { ...DEFAULT_THRESHOLDS } };

  let query = "SELECT * FROM sessions WHERE started_at IS NOT NULL";
  const params: string[] = [];
  if (projectId) { query += " AND project_id = ?"; params.push(projectId); }
  query += " ORDER BY started_at";

  const sessions = db.prepare(query).all(...params) as Record<string, unknown>[];

  if (sessions.length === 0) {
    return { points: [], period: { from: null, to: null } };
  }

  // Group by ISO week (YYYY-Www)
  const weeks = new Map<string, {
    sessions: string[];
    weekStart: string;
    weekEnd: string;
  }>();

  for (const s of sessions) {
    const started = new Date(s.started_at as string);
    const weekKey = getISOWeek(started);

    if (!weeks.has(weekKey)) {
      const { weekStart, weekEnd } = getWeekBounds(started);
      weeks.set(weekKey, { sessions: [], weekStart, weekEnd });
    }
    weeks.get(weekKey)!.sessions.push(s.id as string);
  }

  // Sort weeks chronologically and compute per-week metrics
  const sortedWeeks = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12); // Last 12 weeks

  const points: TrendPoint[] = [];

  for (const [, data] of sortedWeeks) {
    const weekSessions = data.sessions;
    const sessionCount = weekSessions.length;

    // Count sessions with git correlations
    let sessionsWithGit = 0;
    for (const sid of weekSessions) {
      const count = db.prepare(
        "SELECT count(*) as cnt FROM correlations WHERE session_id = ? AND correlation_type = 'git-commit'"
      ).get(sid) as { cnt: number };
      if (count.cnt > 0) sessionsWithGit++;
    }

    // Aggregate test outcomes for sessions in this week
    const sessionIds = weekSessions.map((id) => `'${id}'`).join(',');
    let totalPassed = 0;
    let totalFailed = 0;
    if (sessionIds.length > 0) {
      const testRows = db.prepare(
        `SELECT passed, failed FROM test_outcomes WHERE session_id IN (${sessionIds})`
      ).all() as { passed: number; failed: number }[];
      for (const t of testRows) {
        totalPassed += t.passed || 0;
        totalFailed += t.failed || 0;
      }
    }

    // Compute aggregate score for this week
    let scoreAggregate = 0;
    if (weekSessions.length > 0) {
      const score = computeEffectivenessScore(storage, { projectId, from: data.weekStart, to: data.weekEnd, weights: cfg.weights, thresholds: cfg.thresholds });
      scoreAggregate = score.aggregate;
    }

    points.push({
      weekStart: data.weekStart,
      weekEnd: data.weekEnd,
      sessionCount,
      sessionsWithGit,
      totalTestsPassed: totalPassed,
      totalTestsFailed: totalFailed,
      scoreAggregate,
    });
  }

  return {
    points,
    period: {
      from: points.length > 0 ? points[0].weekStart : null,
      to: points.length > 0 ? points[points.length - 1].weekEnd : null,
    },
  };
}

/** Get ISO week string: YYYY-Www */
function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** Get the Monday and Sunday dates bounding a given date's ISO week. */
function getWeekBounds(date: Date): { weekStart: string; weekEnd: string } {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    weekStart: monday.toISOString().slice(0, 10),
    weekEnd: sunday.toISOString().slice(0, 10),
  };
}
