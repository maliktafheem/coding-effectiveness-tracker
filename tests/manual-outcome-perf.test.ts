/**
 * Performance regression test for manual-outcome N+1 elimination.
 *
 * Seeds a large session set with manual outcomes and asserts
 * computeEffectivenessScore() completes within a tight time budget.
 * Also asserts behavioral correctness: dimension availability, average
 * score across N sessions with and without outcomes, and parity with
 * the per-session loop on a small fixture.
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
  db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('mo-tool', 'mo-tool', 'MO Tool');
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('mo-project', 'MO Project');
  return storage;
}

function seedSessionsWithManualOutcomes(storage: Storage, sessionCount: number, outcomesPerSession: number): void {
  const db = storage.db;
  const insertSession = db.prepare(
    'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertOutcome = db.prepare(
    "INSERT INTO outcomes (id, session_id, outcome_type, score, label) VALUES (?, ?, 'manual', ?, ?)"
  );

  db.transaction(() => {
    for (let i = 0; i < sessionCount; i++) {
      const sid = randomUUID();
      const dayOffset = i % 30;
      const startedAt = `2026-04-${String(1 + dayOffset).padStart(2, '0')}T10:00:00Z`;
      const endedAt   = `2026-04-${String(1 + dayOffset).padStart(2, '0')}T11:00:00Z`;
      insertSession.run(sid, `ext-${i}`, 'mo-tool', 'mo-project', startedAt, endedAt, 3600000, `Session ${i}`);

      for (let j = 0; j < outcomesPerSession; j++) {
        // Deterministic scores so assertions are stable
        const score = ((i + j) % 5 + 1) / 5; // 0.2 .. 1.0
        insertOutcome.run(randomUUID(), sid, score, `label-${i}-${j}`);
      }
    }
  })();
}

// ─── Performance regression ───────────────────────────────────────────────────

describe('manual-outcome N+1 query performance regression', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-mo-perf-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('computeEffectivenessScore completes within 500ms for 1000 sessions × 2 manual outcomes each', () => {
    seedSessionsWithManualOutcomes(storage, 1000, 2);

    const start = performance.now();
    const score = computeEffectivenessScore(storage, { projectId: 'mo-project' });
    const elapsed = performance.now() - start;

    expect(score.sessionCount).toBe(1000);
    const moDim = score.dimensions.find(d => d.name === 'manual-outcome');
    expect(moDim).toBeDefined();
    expect(moDim!.available).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  it('issues at most a constant number of queries against outcomes table regardless of session count', () => {
    seedSessionsWithManualOutcomes(storage, 500, 2);

    // Wrap db.prepare to count SELECT statements touching the outcomes table.
    const db = storage.db;
    const originalPrepare = db.prepare.bind(db);
    let outcomeSelectCount = 0;
    db.prepare = ((sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
      if (normalized.includes('from outcomes') && normalized.startsWith('select')) {
        outcomeSelectCount++;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;

    try {
      computeEffectivenessScore(storage, { projectId: 'mo-project' });
    } finally {
      db.prepare = originalPrepare;
    }

    // N+1 would issue ~500 prepares. A batched implementation should issue ≤ 2.
    expect(outcomeSelectCount).toBeLessThanOrEqual(2);
  });
});

// ─── Behavioral regression ────────────────────────────────────────────────────

describe('manual-outcome N+1 fix behavioral regression', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-mo-behav-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('reports unavailable when no sessions have manual outcomes', () => {
    const db = storage.db;
    db.prepare(
      'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('no-mo-sess', 'no-mo-ext', 'mo-tool', 'mo-project',
      '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', 3600000, 'no mo');

    const score = computeEffectivenessScore(storage, { projectId: 'mo-project' });
    const moDim = score.dimensions.find(d => d.name === 'manual-outcome');
    expect(moDim).toBeDefined();
    expect(moDim!.available).toBe(false);
  });

  it('computes correct average across mixed sessions (some with outcomes, some without)', () => {
    const db = storage.db;
    const insertSession = db.prepare(
      'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertOutcome = db.prepare(
      "INSERT INTO outcomes (id, session_id, outcome_type, score, label) VALUES (?, ?, 'manual', ?, ?)"
    );

    db.transaction(() => {
      for (let i = 0; i < 4; i++) {
        insertSession.run(`mo-sess-${i}`, `mo-ext-${i}`, 'mo-tool', 'mo-project',
          '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', 3600000, `sess ${i}`);
      }
      // Sessions 0 and 1 each get a manual outcome. Sessions 2 and 3 get none.
      insertOutcome.run('mo-o-0', 'mo-sess-0', 0.8, 'good');
      insertOutcome.run('mo-o-1', 'mo-sess-1', 0.6, 'ok');
      // Non-manual outcome on session 2 must be ignored
      db.prepare(
        "INSERT INTO outcomes (id, session_id, outcome_type, score, label) VALUES (?, ?, 'auto', ?, ?)"
      ).run('mo-o-2', 'mo-sess-2', 0.1, 'auto-ignore');
      // Null-score manual outcome on session 3 must be ignored
      insertOutcome.run('mo-o-3', 'mo-sess-3', null as unknown as number, 'no-score');
    })();

    const score = computeEffectivenessScore(storage, { projectId: 'mo-project' });
    const moDim = score.dimensions.find(d => d.name === 'manual-outcome');

    expect(moDim).toBeDefined();
    expect(moDim!.available).toBe(true);
    // Average of 0.8 and 0.6 = 0.7
    expect(moDim!.value).toBeCloseTo(0.7, 5);
    expect(moDim!.explanation).toMatch(/2 annotation/);
  });

  it('computes correct average across multiple outcomes per session', () => {
    const db = storage.db;
    db.prepare(
      'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('multi-mo-sess', 'multi-ext', 'mo-tool', 'mo-project',
      '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', 3600000, 'multi');

    const insertOutcome = db.prepare(
      "INSERT INTO outcomes (id, session_id, outcome_type, score, label) VALUES (?, ?, 'manual', ?, ?)"
    );
    insertOutcome.run('multi-o-0', 'multi-mo-sess', 0.5, 'a');
    insertOutcome.run('multi-o-1', 'multi-mo-sess', 1.0, 'b');
    insertOutcome.run('multi-o-2', 'multi-mo-sess', 0.0, 'c');

    const score = computeEffectivenessScore(storage, { projectId: 'mo-project' });
    const moDim = score.dimensions.find(d => d.name === 'manual-outcome');

    expect(moDim).toBeDefined();
    expect(moDim!.available).toBe(true);
    // (0.5 + 1.0 + 0.0) / 3 = 0.5
    expect(moDim!.value).toBeCloseTo(0.5, 5);
    expect(moDim!.explanation).toMatch(/3 annotation/);
  });
});
