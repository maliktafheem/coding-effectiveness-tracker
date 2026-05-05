/**
 * Correlation engine.
 *
 * Matches AI coding sessions with Git commits, test outcomes, and manual
 * annotations using confidence scoring. Correlation is purely local —
 * no remote API calls.
 */

import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage.js';

export interface CorrelationResult {
  correlationId: string;
  correlationType: 'git-commit' | 'test-outcome' | 'manual-outcome';
  targetId: string;
  confidence: number;
  reasons: string[];
}

/**
 * Correlate a session with all available signals: git commits, test outcomes, and manual outcomes.
 * Stores results in the correlations table and returns them.
 */
export function correlateSession(
  storage: Storage,
  sessionId: string,
): CorrelationResult[] {
  const db = storage.db;

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!session) return [];

  const results: CorrelationResult[] = [];

  // Clear existing correlations for this session to allow re-correlation
  db.prepare('DELETE FROM correlations WHERE session_id = ?').run(sessionId);

  // 1. Correlate with Git commits
  const gitCorrelations = correlateWithGitCommits(storage, session);
  results.push(...gitCorrelations);

  // 2. Correlate with test outcomes
  const testCorrelations = correlateWithTestOutcomes(storage, session);
  results.push(...testCorrelations);

  // 3. Correlate with manual outcomes
  const manualCorrelations = correlateWithManualOutcomes(storage, session);
  results.push(...manualCorrelations);

  // Store all correlations
  const insert = db.prepare(`
    INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const corr of results) {
      insert.run(
        corr.correlationId,
        sessionId,
        corr.correlationType,
        corr.targetId,
        corr.confidence,
        JSON.stringify({ reasons: corr.reasons }),
      );
    }
  });
  insertAll();

  return results;
}

/**
 * Correlate a session with git commits based on time overlap and project matching.
 */
function correlateWithGitCommits(
  storage: Storage,
  session: Record<string, unknown>,
): CorrelationResult[] {
  const db = storage.db;
  const sessionStart = session.started_at as string | null;
  const sessionEnd = session.ended_at as string | null;
  const projectId = session.project_id as string | null;

  if (!sessionStart) return [];

  // Find git commits that overlap with the session time window
  // Expand window by 30 minutes on each side for fuzzy matching
  const windowStart = new Date(new Date(sessionStart).getTime() - 30 * 60 * 1000).toISOString();
  const windowEnd = sessionEnd
    ? new Date(new Date(sessionEnd).getTime() + 30 * 60 * 1000).toISOString()
    : new Date(new Date(sessionStart).getTime() + 2 * 60 * 60 * 1000).toISOString();

  let query = 'SELECT * FROM git_commits WHERE authored_at >= ? AND authored_at <= ?';
  const params: (string | null)[] = [windowStart, windowEnd];

  if (projectId) {
    query += ' AND project_id = ?';
    params.push(projectId);
  }

  const commits = db.prepare(query).all(...params) as Record<string, unknown>[];
  const results: CorrelationResult[] = [];

  for (const commit of commits) {
    const { confidence, reasons } = calculateGitConfidence(session, commit);
    if (confidence > 0) {
      results.push({
        correlationId: randomUUID(),
        correlationType: 'git-commit',
        targetId: commit.id as string,
        confidence,
        reasons,
      });
    }
  }

  return results;
}

/**
 * Calculate confidence score for a session-commit match.
 */
function calculateGitConfidence(
  session: Record<string, unknown>,
  commit: Record<string, unknown>,
): { confidence: number; reasons: string[] } {
  let confidence = 0;
  const reasons: string[] = [];

  const sessionStart = new Date(session.started_at as string).getTime();
  const sessionEnd = session.ended_at
    ? new Date(session.ended_at as string).getTime()
    : sessionStart + 60 * 60 * 1000; // default 1 hour
  const commitTime = new Date(commit.authored_at as string).getTime();

  // Time overlap: commit falls within session window
  if (commitTime >= sessionStart && commitTime <= sessionEnd) {
    confidence += 0.5;
    reasons.push('commit timestamp within session window');

    // Closer to midpoint = higher confidence
    const midTime = (sessionStart + sessionEnd) / 2;
    const halfDuration = (sessionEnd - sessionStart) / 2;
    const distance = Math.abs(commitTime - midTime);
    const proximityScore = 1 - (distance / halfDuration);
    confidence += proximityScore * 0.2;
    reasons.push('commit time proximity to session midpoint');
  } else if (commitTime >= sessionStart - 30 * 60 * 1000 && commitTime <= sessionEnd + 30 * 60 * 1000) {
    // Within fuzzy window but outside session
    confidence += 0.2;
    reasons.push('commit timestamp near session window (within 30min buffer)');
  }

  // Project match
  if (session.project_id && commit.project_id && session.project_id === commit.project_id) {
    confidence += 0.3;
    reasons.push('same project');
  }

  return { confidence: Math.min(confidence, 1), reasons };
}

/**
 * Correlate a session with test outcomes based on time proximity and project.
 */
function correlateWithTestOutcomes(
  storage: Storage,
  session: Record<string, unknown>,
): CorrelationResult[] {
  const db = storage.db;
  const sessionStart = session.started_at as string | null;
  const sessionEnd = session.ended_at as string | null;
  const projectId = session.project_id as string | null;

  if (!sessionStart) return [];

  // Look for test outcomes run during or shortly after the session
  const windowStart = sessionStart;
  const windowEnd = sessionEnd
    ? new Date(new Date(sessionEnd).getTime() + 60 * 60 * 1000).toISOString() // 1 hour after session end
    : new Date(new Date(sessionStart).getTime() + 4 * 60 * 60 * 1000).toISOString();

  let query = 'SELECT * FROM test_outcomes WHERE run_at >= ? AND run_at <= ?';
  const params: (string | null)[] = [windowStart, windowEnd];

  if (projectId) {
    query += ' AND project_id = ?';
    params.push(projectId);
  }

  const outcomes = db.prepare(query).all(...params) as Record<string, unknown>[];
  const results: CorrelationResult[] = [];

  for (const outcome of outcomes) {
    const { confidence, reasons } = calculateTestConfidence(session, outcome);
    if (confidence > 0) {
      results.push({
        correlationId: randomUUID(),
        correlationType: 'test-outcome',
        targetId: outcome.id as string,
        confidence,
        reasons,
      });
    }
  }

  return results;
}

/**
 * Calculate confidence for session-test match.
 */
function calculateTestConfidence(
  session: Record<string, unknown>,
  outcome: Record<string, unknown>,
): { confidence: number; reasons: string[] } {
  let confidence = 0;
  const reasons: string[] = [];

  const sessionEnd = session.ended_at
    ? new Date(session.ended_at as string).getTime()
    : new Date(session.started_at as string).getTime() + 60 * 60 * 1000;
  const testTime = new Date(outcome.run_at as string).getTime();

  // Test run after session end (most common pattern)
  if (testTime >= sessionEnd) {
    const hoursAfter = (testTime - sessionEnd) / (60 * 60 * 1000);
    if (hoursAfter <= 1) {
      confidence += 0.4;
      reasons.push('test run within 1 hour after session end');
    } else if (hoursAfter <= 4) {
      confidence += 0.2;
      reasons.push('test run within 4 hours after session end');
    }
  } else if (testTime >= sessionEnd - 30 * 60 * 1000) {
    // Test run during session end window
    confidence += 0.3;
    reasons.push('test run during session end window');
  }

  // Test results affect confidence
  const passed = outcome.passed as number || 0;
  const failed = outcome.failed as number || 0;
  if (passed > 0 && failed === 0) {
    confidence += 0.1;
    reasons.push('all tests passed');
  } else if (failed > 0) {
    // Failed tests are still a valid correlation signal
    reasons.push(`${failed} test(s) failed`);
  }

  // Project match
  if (session.project_id && outcome.project_id && session.project_id === outcome.project_id) {
    confidence += 0.2;
    reasons.push('same project');
  }

  return { confidence: Math.min(confidence, 1), reasons };
}

/**
 * Correlate a session with its manual outcomes.
 */
function correlateWithManualOutcomes(
  storage: Storage,
  session: Record<string, unknown>,
): CorrelationResult[] {
  const db = storage.db;
  const sessionId = session.id as string;

  const outcomes = db.prepare('SELECT * FROM outcomes WHERE session_id = ?').all(sessionId) as Record<string, unknown>[];
  const results: CorrelationResult[] = [];

  for (const outcome of outcomes) {
    results.push({
      correlationId: randomUUID(),
      correlationType: 'manual-outcome',
      targetId: outcome.id as string,
      confidence: 1.0, // Manual outcomes are explicit — full confidence
      reasons: ['explicit manual annotation by user'],
    });
  }

  return results;
}
