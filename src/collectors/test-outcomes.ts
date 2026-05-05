/**
 * Local test outcome collector.
 *
 * Ingests test result records and stores them in SQLite
 * for correlation with AI coding sessions and git commits.
 */

import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage.js';

export interface TestOutcomeRecord {
  command: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  runAt: string;
  commitId?: string;
  sessionId?: string;
  rawOutputSummary?: string;
}

/**
 * Store test outcome records into the database.
 * Idempotent — generates a new ID for each record but avoids exact duplicates
 * by checking command + runAt + project combination.
 */
export function collectTestOutcomes(
  storage: Storage,
  outcomes: TestOutcomeRecord[],
  projectId: string,
): number {
  if (outcomes.length === 0) return 0;

  const db = storage.db;

  // Check for existing outcomes with same command, runAt, project to avoid duplicates
  const existsQuery = db.prepare(
    'SELECT id FROM test_outcomes WHERE command = ? AND run_at = ? AND project_id = ?',
  );

  const insert = db.prepare(`
    INSERT INTO test_outcomes (id, project_id, session_id, commit_id, command, passed, failed, skipped, duration_ms, raw_output_summary, run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let stored = 0;
  const insertAll = db.transaction(() => {
    for (const outcome of outcomes) {
      // Deduplication: skip if same command+runAt+project already exists
      const existing = existsQuery.get(outcome.command, outcome.runAt, projectId) as { id: string } | undefined;
      if (existing) continue;

      insert.run(
        randomUUID(),
        projectId,
        outcome.sessionId ?? null,
        outcome.commitId ?? null,
        outcome.command,
        outcome.passed,
        outcome.failed,
        outcome.skipped,
        outcome.durationMs,
        outcome.rawOutputSummary ?? null,
        outcome.runAt,
      );
      stored++;
    }
  });
  insertAll();
  return stored;
}
