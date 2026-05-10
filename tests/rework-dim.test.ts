/**
 * Tests for the rework-indicator dimension using SQLite json_extract aggregate.
 *
 * TDD order per spec:
 *   A – 3 sessions, one reworkCount=2, one reworkCount=0, one no metadata → ratio 1/3 → score 2/3
 *   B – 3 sessions, all valid metadata, no reworkCount → available: true, value 1
 *   C – all malformed: 3 sessions with unparseable metadata → available: false
 *   C-mixed – 2 malformed + 1 valid with no rework → available: true, explanation notes unparseable count
 *   D – 1 malformed, 2 valid with reworkCount=1 → score from denominator = all sessions, note in explanation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('rework-tool', 'rework-tool', 'Rework Tool');
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('rework-project', 'Rework Project');
  return storage;
}

function insertSession(storage: Storage, id: string, metadataJson: string | null): void {
  storage.db.prepare(
    'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, `ext-${id}`, 'rework-tool', 'rework-project',
    '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', 3600000, `Session ${id}`, metadataJson);
}

// ─── Test A ───────────────────────────────────────────────────────────────────

describe('rework-indicator: Test A – one session with rework, one zero, one no metadata', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-rework-a-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('ratio 1/3 → score 2/3 ≈ 0.667', () => {
    insertSession(storage, 'a-1', JSON.stringify({ reworkCount: 2 }));
    insertSession(storage, 'a-2', JSON.stringify({ reworkCount: 0 }));
    insertSession(storage, 'a-3', null);

    const score = computeEffectivenessScore(storage, { projectId: 'rework-project' });
    const dim = score.dimensions.find(d => d.name === 'rework-indicator');

    expect(dim).toBeDefined();
    expect(dim!.available).toBe(true);
    // 1 session with rework out of 3 → reworkRatio = 1/3 → score = 1 - 1/3 ≈ 0.667
    expect(dim!.value).toBeCloseTo(2 / 3, 3);
    expect(dim!.explanation).toMatch(/1 of 3/);
    expect(dim!.explanation).toMatch(/2 total/);
  });
});

// ─── Test B ───────────────────────────────────────────────────────────────────

describe('rework-indicator: Test B – all valid metadata, no reworkCount', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-rework-b-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('available: true, value 1 when no rework detected', () => {
    insertSession(storage, 'b-1', JSON.stringify({ someOtherField: 'x' }));
    insertSession(storage, 'b-2', JSON.stringify({ someOtherField: 'y' }));
    insertSession(storage, 'b-3', JSON.stringify({ someOtherField: 'z' }));

    const score = computeEffectivenessScore(storage, { projectId: 'rework-project' });
    const dim = score.dimensions.find(d => d.name === 'rework-indicator');

    expect(dim).toBeDefined();
    expect(dim!.available).toBe(true);
    expect(dim!.value).toBe(1);
    expect(dim!.explanation).toMatch(/No rework/i);
  });
});

// ─── Test C ───────────────────────────────────────────────────────────────────

describe('rework-indicator: Test C – all malformed metadata', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-rework-c-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('available: false when every session has unparseable metadata', () => {
    insertSession(storage, 'c-1', '{not valid json{{');
    insertSession(storage, 'c-2', 'also bad');
    insertSession(storage, 'c-3', 'still bad }}}');

    const score = computeEffectivenessScore(storage, { projectId: 'rework-project' });
    const dim = score.dimensions.find(d => d.name === 'rework-indicator');

    expect(dim).toBeDefined();
    expect(dim!.available).toBe(false);
    expect(dim!.explanation).toMatch(/unparseable metadata/i);
  });
});

// ─── Test C-mixed ─────────────────────────────────────────────────────────────

describe('rework-indicator: Test C-mixed – two malformed, one valid with no rework', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-rework-c-mixed-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('available: true, value 1, explanation notes unparseable count', () => {
    insertSession(storage, 'cm-1', '{not valid json{{');
    insertSession(storage, 'cm-2', 'also bad');
    insertSession(storage, 'cm-3', JSON.stringify({ someField: 1 })); // valid, no reworkCount

    const score = computeEffectivenessScore(storage, { projectId: 'rework-project' });
    const dim = score.dimensions.find(d => d.name === 'rework-indicator');

    expect(dim).toBeDefined();
    expect(dim!.available).toBe(true);
    // No rework observed anywhere → score is 1 (no rework indicator)
    expect(dim!.value).toBe(1);
    // Must still surface how many sessions had unparseable metadata
    expect(dim!.explanation).toMatch(/2 session\(s\) had unparseable metadata/i);
  });
});

// ─── Test D ───────────────────────────────────────────────────────────────────

describe('rework-indicator: Test D – one malformed, two valid with reworkCount=1', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-rework-d-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('score reflects rework across all sessions, explanation notes unparseable count', () => {
    insertSession(storage, 'd-1', '{bad json');
    insertSession(storage, 'd-2', JSON.stringify({ reworkCount: 1 }));
    insertSession(storage, 'd-3', JSON.stringify({ reworkCount: 1 }));

    const score = computeEffectivenessScore(storage, { projectId: 'rework-project' });
    const dim = score.dimensions.find(d => d.name === 'rework-indicator');

    expect(dim).toBeDefined();
    expect(dim!.available).toBe(true);
    // 2 of 3 sessions had rework → reworkRatio = 2/3 → score = 1/3 ≈ 0.333
    expect(dim!.value).toBeCloseTo(1 / 3, 3);
    // explanation must mention the unparseable session count
    expect(dim!.explanation).toMatch(/1 session\(s\) had unparseable metadata/i);
  });
});
