import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../src/storage.js';
import {
  computeSingle,
  computeAll,
  getAllResults,
  getResult,
} from '../src/analytics/prompt-quality/service.js';

function seedSession(
  storage: Storage,
  id: string,
  opts: { toolId?: string; prompt?: string; assistantTurns?: number; startedAt?: string } = {},
): void {
  const toolId = opts.toolId ?? 't1';
  storage.db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run(toolId, toolId, toolId);
  storage.db.prepare(
    'INSERT INTO sessions (id, source_tool_id, started_at) VALUES (?, ?, ?)',
  ).run(id, toolId, opts.startedAt ?? '2026-01-01T00:00:00Z');

  if (opts.prompt !== undefined) {
    storage.db.prepare(
      `INSERT INTO events (id, session_id, event_type, occurred_at, summary, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), id, 'user-message', '2026-01-01T00:00:00Z', opts.prompt, null);
  }
  for (let i = 0; i < (opts.assistantTurns ?? 0); i++) {
    storage.db.prepare(
      `INSERT INTO events (id, session_id, event_type, occurred_at, summary, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), id, 'assistant-message', `2026-01-01T00:00:${10 + i}Z`, 'ok', null);
  }
}

describe('prompt-quality service', () => {
  let dir: string;
  let storage: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cet-pq-'));
    storage = Storage.open({ dataDir: dir });
  });

  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('computeSingle stores result and returns it', async () => {
    seedSession(storage, 's1', { prompt: 'refactor auth module with care' });
    const result = await computeSingle(storage, 's1');
    expect(result).not.toBeNull();
    expect(result!.overall).toBeGreaterThan(0);
    expect(result!.analyzerId).toBe('heuristic-v1');

    const stored = storage.db.prepare('SELECT prompt_quality_json FROM sessions WHERE id = ?').get('s1') as { prompt_quality_json: string };
    expect(JSON.parse(stored.prompt_quality_json).overall).toBe(result!.overall);
  });

  it('computeSingle returns null for unknown session', async () => {
    const result = await computeSingle(storage, 'does-not-exist');
    expect(result).toBeNull();
  });

  it('computeSingle skips recomputation when cached (no analyzer re-run)', async () => {
    seedSession(storage, 's1', { prompt: 'hello' });
    await computeSingle(storage, 's1');
    const stored1 = storage.db.prepare('SELECT prompt_quality_json FROM sessions WHERE id = ?').get('s1') as { prompt_quality_json: string };
    const computedAt1 = JSON.parse(stored1.prompt_quality_json).computedAt;

    // Wait long enough that computedAt would change if re-run
    await new Promise((r) => setTimeout(r, 5));
    await computeSingle(storage, 's1');
    const stored2 = storage.db.prepare('SELECT prompt_quality_json FROM sessions WHERE id = ?').get('s1') as { prompt_quality_json: string };
    const computedAt2 = JSON.parse(stored2.prompt_quality_json).computedAt;

    expect(computedAt2).toBe(computedAt1);
  });

  it('computeSingle with recompute=true re-runs analyzer', async () => {
    seedSession(storage, 's1', { prompt: 'hello' });
    await computeSingle(storage, 's1');
    const stored1 = storage.db.prepare('SELECT prompt_quality_json FROM sessions WHERE id = ?').get('s1') as { prompt_quality_json: string };
    const at1 = JSON.parse(stored1.prompt_quality_json).computedAt;

    await new Promise((r) => setTimeout(r, 5));
    await computeSingle(storage, 's1', { recompute: true });
    const stored2 = storage.db.prepare('SELECT prompt_quality_json FROM sessions WHERE id = ?').get('s1') as { prompt_quality_json: string };
    const at2 = JSON.parse(stored2.prompt_quality_json).computedAt;

    expect(at2).not.toBe(at1);
  });

  it('computeAll populates only uncomputed sessions by default', async () => {
    seedSession(storage, 's1', { prompt: 'one' });
    seedSession(storage, 's2', { prompt: 'two' });
    await computeSingle(storage, 's1');

    const summary = await computeAll(storage);
    expect(summary.skipped).toBe(1); // s1 was cached
    expect(summary.computed).toBe(1); // only s2

    const all = storage.db.prepare("SELECT COUNT(*) as c FROM sessions WHERE prompt_quality_json IS NOT NULL").get() as { c: number };
    expect(all.c).toBe(2);
  });

  it('computeAll with recompute=true re-runs all', async () => {
    seedSession(storage, 's1', { prompt: 'one' });
    seedSession(storage, 's2', { prompt: 'two' });
    const first = await computeAll(storage);
    expect(first.computed).toBe(2);

    const second = await computeAll(storage, { recompute: true });
    expect(second.computed).toBe(2);
  });

  it('getAllResults returns stored results in DESC started_at order', async () => {
    seedSession(storage, 's1', { prompt: 'a', startedAt: '2026-01-01T00:00:00Z' });
    seedSession(storage, 's2', { prompt: 'b', startedAt: '2026-03-01T00:00:00Z' });
    seedSession(storage, 's3', { prompt: 'c', startedAt: '2026-02-01T00:00:00Z' });
    await computeAll(storage);

    const results = getAllResults(storage);
    expect(results.map((r) => r.sessionId)).toEqual(['s2', 's3', 's1']);
    expect(results[0].overall).toBeGreaterThanOrEqual(0);
    expect(results[0].analyzerId).toBe('heuristic-v1');
  });

  it('getAllResults excludes sessions without stored quality', async () => {
    seedSession(storage, 's1', { prompt: 'computed' });
    seedSession(storage, 's2', { prompt: 'not-computed' });
    await computeSingle(storage, 's1');

    const results = getAllResults(storage);
    expect(results.map((r) => r.sessionId)).toEqual(['s1']);
  });

  it('getResult returns null for uncomputed session', () => {
    seedSession(storage, 's1', { prompt: 'hi' });
    expect(getResult(storage, 's1')).toBeNull();
  });

  it('getResult returns stored result after compute', async () => {
    seedSession(storage, 's1', { prompt: 'hi' });
    await computeSingle(storage, 's1');
    const r = getResult(storage, 's1');
    expect(r).not.toBeNull();
    expect(r!.analyzerId).toBe('heuristic-v1');
  });

  it('uses custom analyzer id when specified', async () => {
    seedSession(storage, 's1', { prompt: 'hi' });
    await expect(computeSingle(storage, 's1', { analyzerId: 'does-not-exist' }))
      .rejects.toThrow(/Unknown analyzer/);
  });
});
