import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Storage } from '../src/storage.js';
import { createApiServer, type DashboardServer } from '../src/api/server.js';

function mkRepo(): { dir: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'api-diff-repo-'));
  const run = (c: string, a: string[]): string =>
    execFileSync(c, a, { cwd: dir, encoding: 'utf-8' });
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.email', 't@t']);
  run('git', ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'f.txt'), 'a\n');
  run('git', ['add', 'f.txt']);
  run('git', ['commit', '-q', '-m', 'init']);
  writeFileSync(join(dir, 'f.txt'), 'a\nb\n');
  run('git', ['add', 'f.txt']);
  run('git', ['commit', '-q', '-m', 'change']);
  const hash = run('git', ['rev-parse', 'HEAD']).trim();
  return { dir, hash };
}

describe('GET /api/sessions/:id/diff', () => {
  let dataDir: string;
  let repo: ReturnType<typeof mkRepo>;
  let sessionId: string;
  let server: DashboardServer;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'api-diff-data-'));
    const storage = Storage.open({ dataDir });
    repo = mkRepo();
    sessionId = randomUUID();
    const commitId = randomUUID();
    const db = storage.db as unknown as Database.Database;
    db.prepare('INSERT INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t', 't', 'T');
    db.prepare('INSERT INTO sessions (id, source_tool_id, metadata_json) VALUES (?, ?, ?)').run(
      sessionId,
      't',
      JSON.stringify({ projectPath: repo.dir }),
    );
    db.prepare('INSERT INTO git_commits (id, hash, short_hash, message) VALUES (?, ?, ?, ?)').run(
      commitId,
      repo.hash,
      repo.hash.slice(0, 7),
      'change',
    );
    db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
    ).run(randomUUID(), sessionId, commitId);
    storage.close();

    server = await createApiServer({ dataDir, port: 43301 });
  });

  afterEach(async () => {
    await server.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows locks */ }
    try { rmSync(repo.dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('returns diff when repo resolvable via metadata', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/diff`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { commits: Array<{ diff?: string; stats: { files: number } }> };
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0].diff).toContain('+b');
    expect(body.commits[0].stats.files).toBe(1);
  });

  it('returns 404 for unknown session', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/sessions/missing/diff`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when no repo and no metadata projectPath', async () => {
    const dataDir2 = mkdtempSync(join(tmpdir(), 'api-diff-data2-'));
    const storage = Storage.open({ dataDir: dataDir2 });
    const sid = randomUUID();
    storage.db.prepare('INSERT INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t', 't', 'T');
    storage.db.prepare('INSERT INTO sessions (id, source_tool_id) VALUES (?, ?)').run(sid, 't');
    storage.close();
    const svr = await createApiServer({ dataDir: dataDir2, port: 43302 });
    try {
      const res = await svr.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/diff`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await svr.close();
      try { rmSync(dataDir2, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('respects refresh=1 query', async () => {
    const first = await server.inject({ method: 'GET', url: `/api/sessions/${sessionId}/diff` });
    expect(first.statusCode).toBe(200);
    const again = await server.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/diff?refresh=1`,
    });
    expect(again.statusCode).toBe(200);
    const body = JSON.parse(again.payload) as { commits: Array<{ diff?: string }> };
    expect(body.commits[0].diff).toContain('+b');
  });
});
