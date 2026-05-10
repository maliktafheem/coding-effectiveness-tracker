import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../src/storage.js';
import { createApiServer } from '../src/api/server.js';
import { computeSingle } from '../src/analytics/prompt-quality/service.js';

function seedSession(storage: Storage, id: string, prompt: string): string | undefined {
  storage.db
    .prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)')
    .run('t', 't', 'T');
  storage.db
    .prepare('INSERT INTO sessions (id, source_tool_id, started_at) VALUES (?, ?, ?)')
    .run(id, 't', '2026-01-01T00:00:00Z');
  storage.db
    .prepare(
      'INSERT INTO events (id, session_id, event_type, occurred_at, summary, metadata_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(randomUUID(), id, 'user-message', '2026-01-01T00:00:00Z', prompt, null);
  return id;
}

describe('GET /api/prompt-quality', () => {
  let dataDir: string;
  let server: Awaited<ReturnType<typeof createApiServer>>;
  let storage: Storage;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'api-pq-'));
    storage = Storage.open({ dataDir });
    // Seed 2 sessions, compute both, then seed a 3rd uncomputed
    seedSession(storage, 's1', 'refactor auth module');
    seedSession(storage, 's2', 'add validation to input handler');
    await computeSingle(storage, 's1');
    await computeSingle(storage, 's2');
    seedSession(storage, 's3', 'quick fix');
    storage.close();

    server = await createApiServer({ dataDir, port: 43303 });
  });

  afterEach(async () => {
    await server.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns sessions + avgOverall for seeded computed data', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/prompt-quality',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.sessions).toHaveLength(2);
    expect(typeof body.avgOverall).toBe('number');
    expect(body.avgOverall).toBeGreaterThan(0);
    expect(body.analyzer).toBe('heuristic-v1');
    expect(body.sessions[0].sessionId).toBeDefined();
    expect(body.sessions[0].overall).toBeGreaterThan(0);
    expect(body.sessions[0].signals).toBeDefined();
  });

  it('includes promptQuality in GET /api/sessions/:id when computed', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/sessions/s1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.promptQuality).toBeDefined();
    expect(body.promptQuality.overall).toBeGreaterThan(0);
    expect(body.promptQuality.analyzerId).toBe('heuristic-v1');
  });

  it('omits promptQuality when session not computed', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/sessions/s3',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.promptQuality).toBeUndefined();
  });
});

describe('GET /api/prompt-quality empty DB', () => {
  let dataDir: string;
  let server: Awaited<ReturnType<typeof createApiServer>>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'api-pq-empty-'));
    Storage.open({ dataDir }).close();
    server = await createApiServer({ dataDir, port: 43304 });
  });

  afterEach(async () => {
    await server.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns empty sessions array and 0 avg (no 500)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/prompt-quality',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.sessions).toEqual([]);
    expect(body.avgOverall).toBe(0);
    expect(body.analyzer).toBe('heuristic-v1');
  });
});
