/**
 * Tests for computeTrends — analytics weekly rolling aggregator.
 *
 * Covers: empty DB, single-session week, multi-week bucketing,
 * project filtering narrowing and empty-filter paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../src/storage.js';
import { ensureDataDir } from '../src/config.js';
import { computeTrends } from '../src/analytics/trends.js';

function safeCleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows file locks */ }
}

function createTestStorage(tempDir: string): Storage {
  const dataDir = ensureDataDir(join(tempDir, 'data'));
  const storage = Storage.open({ dataDir });
  const db = storage.db;
  db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('tr-tool', 'tr-tool', 'TR Tool');
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('tr-proj-a', 'Proj A');
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('tr-proj-b', 'Proj B');
  return storage;
}

function insertSession(
  storage: Storage,
  id: string,
  projectId: string,
  startedAt: string,
  endedAt: string,
): void {
  storage.db.prepare(
    'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, `ext-${id}`, 'tr-tool', projectId, startedAt, endedAt, 3600000, `Sess ${id}`);
}

function insertGitCorrelation(storage: Storage, id: string, sessionId: string): void {
  storage.db.prepare(
    "INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence) VALUES (?, ?, 'git-commit', ?, 0.9)"
  ).run(id, sessionId, `commit-${id}`);
}

function insertTestOutcome(
  storage: Storage,
  id: string,
  sessionId: string,
  passed: number,
  failed: number,
): void {
  storage.db.prepare(
    'INSERT INTO test_outcomes (id, session_id, project_id, command, passed, failed, skipped, duration_ms, run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, sessionId, 'tr-proj-a', 'npm test', passed, failed, 0, 1000, '2026-04-01T09:00:00Z');
}

describe('computeTrends: empty DB', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-trends-empty-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('returns empty points and null period when no sessions exist', () => {
    const trends = computeTrends(storage);

    expect(trends.points).toEqual([]);
    expect(trends.period.from).toBeNull();
    expect(trends.period.to).toBeNull();
  });

  it('returns empty points and null period when filtered to a project with no sessions', () => {
    // Seed a session in a different project — filter by another project id
    insertSession(storage, 's1', 'tr-proj-a', '2026-04-06T10:00:00Z', '2026-04-06T11:00:00Z');

    const trends = computeTrends(storage, 'tr-proj-b');

    expect(trends.points).toEqual([]);
    expect(trends.period.from).toBeNull();
    expect(trends.period.to).toBeNull();
  });
});

describe('computeTrends: single week', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-trends-single-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('produces a single point for sessions within one ISO week', () => {
    // Monday 2026-04-06 through Friday 2026-04-10 — same ISO week
    insertSession(storage, 's1', 'tr-proj-a', '2026-04-06T10:00:00Z', '2026-04-06T11:00:00Z');
    insertSession(storage, 's2', 'tr-proj-a', '2026-04-08T10:00:00Z', '2026-04-08T11:00:00Z');
    insertGitCorrelation(storage, 'c1', 's1');
    insertTestOutcome(storage, 't1', 's2', 5, 1);

    const trends = computeTrends(storage);

    expect(trends.points).toHaveLength(1);
    const p = trends.points[0];
    expect(p.sessionCount).toBe(2);
    expect(p.sessionsWithGit).toBe(1);
    expect(p.totalTestsPassed).toBe(5);
    expect(p.totalTestsFailed).toBe(1);
    expect(p.weekStart).toBeDefined();
    expect(p.weekEnd).toBeDefined();
    expect(typeof p.scoreAggregate).toBe('number');
  });
});

describe('computeTrends: multi-week bucketing', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-trends-multi-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('buckets sessions into distinct ISO weeks in chronological order', () => {
    // Three distinct weeks
    insertSession(storage, 'w1a', 'tr-proj-a', '2026-04-06T10:00:00Z', '2026-04-06T11:00:00Z'); // week of Apr 6
    insertSession(storage, 'w1b', 'tr-proj-a', '2026-04-07T10:00:00Z', '2026-04-07T11:00:00Z');
    insertSession(storage, 'w2a', 'tr-proj-a', '2026-04-13T10:00:00Z', '2026-04-13T11:00:00Z'); // week of Apr 13
    insertSession(storage, 'w3a', 'tr-proj-a', '2026-04-20T10:00:00Z', '2026-04-20T11:00:00Z'); // week of Apr 20
    insertSession(storage, 'w3b', 'tr-proj-a', '2026-04-22T10:00:00Z', '2026-04-22T11:00:00Z');
    insertSession(storage, 'w3c', 'tr-proj-a', '2026-04-24T10:00:00Z', '2026-04-24T11:00:00Z');

    const trends = computeTrends(storage);

    expect(trends.points).toHaveLength(3);
    // Sorted chronologically by weekStart
    const starts = trends.points.map(p => p.weekStart);
    expect([...starts]).toEqual([...starts].sort());
    // Session counts per week
    expect(trends.points[0].sessionCount).toBe(2);
    expect(trends.points[1].sessionCount).toBe(1);
    expect(trends.points[2].sessionCount).toBe(3);
    // period bounds match the first and last point
    expect(trends.period.from).toBe(trends.points[0].weekStart);
    expect(trends.period.to).toBe(trends.points[trends.points.length - 1].weekEnd);
  });
});

describe('computeTrends: project filter', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-trends-filter-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('narrows results to sessions in the requested project', () => {
    insertSession(storage, 'a1', 'tr-proj-a', '2026-04-06T10:00:00Z', '2026-04-06T11:00:00Z');
    insertSession(storage, 'a2', 'tr-proj-a', '2026-04-07T10:00:00Z', '2026-04-07T11:00:00Z');
    insertSession(storage, 'b1', 'tr-proj-b', '2026-04-06T10:00:00Z', '2026-04-06T11:00:00Z');

    const trendsA = computeTrends(storage, 'tr-proj-a');
    const trendsB = computeTrends(storage, 'tr-proj-b');
    const trendsAll = computeTrends(storage);

    expect(trendsA.points).toHaveLength(1);
    expect(trendsA.points[0].sessionCount).toBe(2);

    expect(trendsB.points).toHaveLength(1);
    expect(trendsB.points[0].sessionCount).toBe(1);

    expect(trendsAll.points).toHaveLength(1);
    expect(trendsAll.points[0].sessionCount).toBe(3);
  });
});
