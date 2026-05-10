import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../src/storage.js';
import { createApiServer, type DashboardServer } from '../src/api/server.js';

/**
 * Seed helper: insert tool + session + git-commit correlation + (optionally) pr-outcome.
 */
function seedSession(opts: {
  storage: Storage;
  sessionId?: string;
  hasCommit?: boolean;
  prMeta?: {
    prNumber: number;
    state: 'merged' | 'closed' | 'open';
    title: string;
    url: string;
    mergedAt: string | null;
    closedAt: string | null;
    reverted: boolean;
  } | null;
}) {
  const db = opts.storage.db;
  const sid = opts.sessionId ?? randomUUID();

  db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t', 't', 'T');
  db.prepare('INSERT INTO sessions (id, source_tool_id) VALUES (?, ?)').run(sid, 't');

  if (opts.hasCommit ?? true) {
    const commitId = randomUUID();
    db.prepare('INSERT INTO git_commits (id, hash, short_hash, message) VALUES (?, ?, ?, ?)').run(
      commitId,
      'a'.repeat(40),
      'aaaaaaa',
      'test commit',
    );
    db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
    ).run(randomUUID(), sid, commitId);
  }

  if (opts.prMeta) {
    db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'pr-outcome', ?, 1, ?)`,
    ).run(randomUUID(), sid, String(opts.prMeta.prNumber), JSON.stringify(opts.prMeta));
  }

  return sid;
}

describe('GET /api/timeline — shipStatus', () => {
  let dataDir: string;
  let server: DashboardServer;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'api-ship-status-'));
    server = await createApiServer({ dataDir, port: 43401 });
  });

  afterEach(async () => {
    await server.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns shipStatus=unlinked for session with no commits', async () => {
    const storage = Storage.open({ dataDir });
    seedSession({ storage, hasCommit: false });
    storage.close();

    const res = await server.inject({ method: 'GET', url: '/api/timeline' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].shipStatus).toBe('unlinked');
  });

  it('returns shipStatus=shipped for session with merged PR', async () => {
    const storage = Storage.open({ dataDir });
    seedSession({
      storage,
      prMeta: {
        prNumber: 42,
        state: 'merged',
        title: 'Fix bug',
        url: 'https://github.com/foo/bar/pull/42',
        mergedAt: '2025-01-01T00:00:00Z',
        closedAt: null,
        reverted: false,
      },
    });
    storage.close();

    const res = await server.inject({ method: 'GET', url: '/api/timeline' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].shipStatus).toBe('shipped');
  });
});

describe('GET /api/overview — shipStatusBreakdown', () => {
  let dataDir: string;
  let server: DashboardServer;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'api-ship-status-ov-'));
    server = await createApiServer({ dataDir, port: 43402 });
  });

  afterEach(async () => {
    await server.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns correct shipStatusBreakdown counts', async () => {
    const storage = Storage.open({ dataDir });

    // shipped
    seedSession({ storage, prMeta: { prNumber: 1, state: 'merged', title: 'a', url: '', mergedAt: '', closedAt: null, reverted: false } });
    // reverted
    seedSession({ storage, prMeta: { prNumber: 2, state: 'merged', title: 'b', url: '', mergedAt: '', closedAt: null, reverted: true } });
    // abandoned (closed without merge)
    seedSession({ storage, prMeta: { prNumber: 3, state: 'closed', title: 'c', url: '', mergedAt: null, closedAt: '', reverted: false } });
    // in-flight (open PR)
    seedSession({ storage, prMeta: { prNumber: 4, state: 'open', title: 'd', url: '', mergedAt: null, closedAt: null, reverted: false } });
    // no PR data (has commit but no pr-outcome)
    seedSession({ storage, hasCommit: true, prMeta: null });
    // unlinked (no commit at all)
    seedSession({ storage, hasCommit: false });

    storage.close();

    const res = await server.inject({ method: 'GET', url: '/api/overview' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.shipStatusBreakdown).toEqual({
      shipped: 1,
      reverted: 1,
      abandoned: 1,
      inFlight: 1,
      noPrData: 1,
      unlinked: 1,
    });
  });
});

describe('GET /api/sessions/:id — shipStatus + prs', () => {
  let dataDir: string;
  let server: DashboardServer;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'api-ship-status-sd-'));
    server = await createApiServer({ dataDir, port: 43403 });
  });

  afterEach(async () => {
    await server.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns shipStatus + empty prs when no PR correlations', async () => {
    const storage = Storage.open({ dataDir });
    const sid = seedSession({ storage, hasCommit: false });
    storage.close();

    const res = await server.inject({ method: 'GET', url: `/api/sessions/${sid}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.shipStatus).toBe('unlinked');
    expect(body.prs).toEqual([]);
  });

  it('returns shipStatus + prs when PR correlations present', async () => {
    const storage = Storage.open({ dataDir });
    const sid = seedSession({
      storage,
      prMeta: {
        prNumber: 99,
        state: 'merged',
        title: 'Great PR',
        url: 'https://github.com/o/r/pull/99',
        mergedAt: '2025-06-01T12:00:00Z',
        closedAt: null,
        reverted: false,
      },
    });
    storage.close();

    const res = await server.inject({ method: 'GET', url: `/api/sessions/${sid}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.shipStatus).toBe('shipped');
    expect(body.prs).toHaveLength(1);
    expect(body.prs[0]).toMatchObject({
      prNumber: 99,
      state: 'merged',
      title: 'Great PR',
      url: 'https://github.com/o/r/pull/99',
      mergedAt: '2025-06-01T12:00:00Z',
      closedAt: null,
      reverted: false,
    });
  });
});
