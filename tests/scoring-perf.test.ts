/**
 * Performance regression tests for N+1 correlation query elimination.
 *
 * These tests seed ~500 sessions with ~2000 correlations and assert that
 * computeEffectivenessScore() completes within a reasonable time budget.
 * They also assert behavioral correctness so the fix cannot silently change
 * git-correlation or test-confidence values.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../src/storage.js';
import { ensureDataDir } from '../src/config.js';
import { computeEffectivenessScore } from '../src/scoring/effectiveness.js';

function safeCleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows file locks */ }
}

function createTestStorage(tempDir: string): Storage {
  const dataDir = ensureDataDir(join(tempDir, 'data'));
  const storage = Storage.open({ dataDir });
  const db = storage.db;
  db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('perf-tool', 'perf-tool', 'Perf Tool');
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('perf-project', 'Perf Project');
  return storage;
}

/**
 * Seed N sessions with correlations distributed across them.
 * Returns the list of inserted session IDs.
 */
function seedLargeDataset(storage: Storage, sessionCount: number, correlationsPerSession: number): string[] {
  const db = storage.db;
  const sessionIds: string[] = [];

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertCorr = db.prepare(
    "INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence) VALUES (?, ?, ?, ?, ?)"
  );

  const seedAll = db.transaction(() => {
    for (let i = 0; i < sessionCount; i++) {
      const sid = randomUUID();
      sessionIds.push(sid);
      // Spread sessions across a 30-day window
      const dayOffset = i % 30;
      const startedAt = `2026-04-${String(1 + dayOffset).padStart(2, '0')}T10:00:00Z`;
      const endedAt   = `2026-04-${String(1 + dayOffset).padStart(2, '0')}T11:00:00Z`;
      insertSession.run(sid, `ext-${i}`, 'perf-tool', 'perf-project', startedAt, endedAt, 3600000, `Session ${i}`);

      // Alternate correlation types so both git and test dimensions get data
      for (let j = 0; j < correlationsPerSession; j++) {
        const corrType = j % 2 === 0 ? 'git-commit' : 'test-outcome';
        insertCorr.run(randomUUID(), sid, corrType, `target-${i}-${j}`, 0.8);
      }
    }
  });

  seedAll();
  return sessionIds;
}

// ─── Performance regression ───────────────────────────────────────────────────

describe('N+1 correlation query performance regression', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-perf-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('computeEffectivenessScore completes within 500ms for 500 sessions × 4 correlations each', () => {
    seedLargeDataset(storage, 500, 4); // 500 sessions, 2000 correlations total

    const start = performance.now();
    const score = computeEffectivenessScore(storage, { projectId: 'perf-project' });
    const elapsed = performance.now() - start;

    expect(score.sessionCount).toBe(500);
    expect(elapsed).toBeLessThan(500);
  });

  it('computeEffectivenessScore completes within 1000ms for 1000 sessions × 4 correlations each', () => {
    seedLargeDataset(storage, 1000, 4); // 1000 sessions, 4000 correlations total

    const start = performance.now();
    const score = computeEffectivenessScore(storage, { projectId: 'perf-project' });
    const elapsed = performance.now() - start;

    expect(score.sessionCount).toBe(1000);
    expect(elapsed).toBeLessThan(1000);
  });
});

// ─── Behavioral regression ────────────────────────────────────────────────────

describe('N+1 fix behavioral regression: git-correlation value', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-behav-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('git-correlation dimension value matches known fixture: 3 of 5 sessions correlated', () => {
    const db = storage.db;
    const sessionIds: string[] = [];

    // Insert 5 sessions
    const insertSession = db.prepare(
      'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertCorr = db.prepare(
      "INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence) VALUES (?, ?, ?, ?, ?)"
    );

    db.transaction(() => {
      for (let i = 0; i < 5; i++) {
        const sid = `behav-sess-${i}`;
        sessionIds.push(sid);
        insertSession.run(sid, `behav-ext-${i}`, 'perf-tool', 'perf-project',
          '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', 3600000, `Behav session ${i}`);
      }
      // Only sessions 0, 1, 2 get a git-commit correlation (3 of 5)
      for (let i = 0; i < 3; i++) {
        insertCorr.run(`behav-corr-${i}`, sessionIds[i], 'git-commit', `gc-${i}`, 0.9);
      }
    })();

    const score = computeEffectivenessScore(storage, { projectId: 'perf-project' });
    const gitDim = score.dimensions.find(d => d.name === 'git-correlation');

    expect(gitDim).toBeDefined();
    expect(gitDim!.available).toBe(true);
    // 3/5 = 0.6
    expect(gitDim!.value).toBeCloseTo(0.6, 5);
    expect(gitDim!.explanation).toMatch(/3 of 5/);
  });

  it('test-confidence correlation ratio matches known fixture: 2 of 4 sessions linked to test-outcome', () => {
    const db = storage.db;

    // Insert test outcomes so the dimension is available
    db.prepare('INSERT INTO test_outcomes (id, project_id, command, passed, failed, skipped, duration_ms, run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('to-behav-1', 'perf-project', 'npm test', 10, 0, 0, 1000, '2026-04-01T09:00:00Z');

    const insertSession = db.prepare(
      'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertCorr = db.prepare(
      "INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence) VALUES (?, ?, ?, ?, ?)"
    );

    db.transaction(() => {
      for (let i = 0; i < 4; i++) {
        const sid = `tc-sess-${i}`;
        insertSession.run(sid, `tc-ext-${i}`, 'perf-tool', 'perf-project',
          '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', 3600000, `TC session ${i}`);
      }
      // Only sessions 0 and 1 get a test-outcome correlation (2 of 4)
      insertCorr.run('tc-corr-0', 'tc-sess-0', 'test-outcome', 'to-behav-1', 0.9);
      insertCorr.run('tc-corr-1', 'tc-sess-1', 'test-outcome', 'to-behav-1', 0.9);
    })();

    const score = computeEffectivenessScore(storage, { projectId: 'perf-project' });
    const testDim = score.dimensions.find(d => d.name === 'test-confidence');

    expect(testDim).toBeDefined();
    expect(testDim!.available).toBe(true);
    // correlationRatio = 2/4 = 0.5; passRate = 10/10 = 1.0
    // score = 1.0 * 0.6 + 0.5 * 0.4 = 0.8
    expect(testDim!.value).toBeCloseTo(0.8, 5);
  });

  it('sessions with zero correlations still report available: false for git-correlation', () => {
    const db = storage.db;
    db.prepare(
      'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('no-corr-sess', 'no-corr-ext', 'perf-tool', 'perf-project',
      '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', 3600000, 'No corr session');

    const score = computeEffectivenessScore(storage, { projectId: 'perf-project' });
    const gitDim = score.dimensions.find(d => d.name === 'git-correlation');

    expect(gitDim).toBeDefined();
    expect(gitDim!.available).toBe(false);
  });
});
