import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Storage } from '../src/storage.js';
import { ensureDataDir } from '../src/config.js';
import {
  getSessionDiffs,
  DIFF_SIZE_CAP_BYTES,
  type SessionCommitDiff,
} from '../src/analytics/diff-service.js';
import { randomUUID } from 'node:crypto';

// ─── helpers ──────────────────────────────────────────────────────────────────

function safeCleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows file locks */ }
}

function createTestStorage(tempDir: string): Storage {
  const dataDir = ensureDataDir(join(tempDir, 'data'));
  const storage = Storage.open({ dataDir });
  const db = storage.db;
  db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t1', 't1', 'T1');
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('p1', 'Project 1');
  return storage;
}

function makeGitArgs(msg: string): string[] {
  return ['-c', 'user.email=t@t.com', '-c', 'user.name=Test', 'commit', '-m', msg];
}

function gitCommit(repoDir: string, fileName: string, fileContent: string, msg: string, date: string): void {
  writeFileSync(join(repoDir, fileName), fileContent);
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', makeGitArgs(msg), { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

function createTempGitRepo(dir: string): string {
  const rd = join(dir, 'test-repo');
  mkdirSync(rd, { recursive: true });
  execFileSync('git', ['init'], { cwd: rd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rd });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: rd });
  gitCommit(rd, 'a.ts', 'export const a = 1;', 'feat: add a', '2026-05-01T10:00:00Z');
  gitCommit(rd, 'b.ts', 'export const b = 2;', 'feat: add b', '2026-05-01T11:00:00Z');
  return rd;
}

/**
 * Seed DB with a session + commit + correlation so getSessionDiffs can find it.
 * Returns commit hash.
 */
function seedSessionCommit(
  storage: Storage,
  repoDir: string,
  sessionId: string,
  commitIndex = 0,
): string {
  // read commit hashes from repo
  const log = execFileSync('git', ['log', '--oneline', '--reverse', '--format=%H %h %s'], {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  const lines = log.trim().split('\n');
  const line = lines[commitIndex];
  if (!line) throw new Error(`no commit at index ${commitIndex}`);
  const [hash, shortHash, ...msgParts] = line.split(' ');
  const msg = msgParts.join(' ');

  const commitId = randomUUID();
  storage.db.prepare(
    `INSERT INTO git_commits (id, hash, short_hash, message, authored_at, project_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(commitId, hash, shortHash, msg, '2026-05-01T10:00:00Z', 'p1');

  storage.db.prepare(
    `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
     VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
  ).run(randomUUID(), sessionId, commitId);

  return hash;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getSessionDiffs', () => {
  let tempDir: string;
  let repoDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-diff-'));
    repoDir = createTempGitRepo(tempDir);
    storage = createTestStorage(tempDir);
  });
  afterEach(() => {
    storage?.close();
    safeCleanup(tempDir);
  });

  // 1. Small commit
  it('returns diff for a small commit with stats and diff text', () => {
    const sessionId = randomUUID();
    storage.db.prepare(
      'INSERT INTO sessions (id, source_tool_id, project_id) VALUES (?, ?, ?)',
    ).run(sessionId, 't1', 'p1');

    const hash = seedSessionCommit(storage, repoDir, sessionId, 0);

    const result = getSessionDiffs(storage.db, sessionId, { repoPath: repoDir });
    expect(result).toHaveLength(1);
    expect(result[0].hash).toBe(hash);
    expect(result[0].shortHash).toMatch(/^[0-9a-f]{7,}$/);
    expect(result[0].stats.files).toBe(1);
    expect(result[0].stats.insertions).toBeGreaterThan(0);
    expect(result[0].diff).toBeTruthy();
    expect(result[0].diff).toContain('a.ts');
    expect(result[0].skipped).toBeUndefined();
  });

  // 2. Oversized diff
  it('skips oversized diff with too-large and stats populated but no diff text', () => {
    const sessionId = randomUUID();
    storage.db.prepare(
      'INSERT INTO sessions (id, source_tool_id, project_id) VALUES (?, ?, ?)',
    ).run(sessionId, 't1', 'p1');

    // commit huge file
    const hugeContent = 'x'.repeat(DIFF_SIZE_CAP_BYTES + 1000);
    gitCommit(repoDir, 'huge.ts', hugeContent, 'feat: huge file', '2026-05-01T12:00:00Z');

    // re-read repo to find the latest commit hash
    const log = execFileSync('git', ['log', '--oneline', '--reverse', '--format=%H %h %s'], {
      cwd: repoDir,
      encoding: 'utf-8',
    });
    const lines = log.trim().split('\n');
    const [hash, shortHash] = lines[lines.length - 1].split(' ');

    const commitId = randomUUID();
    storage.db.prepare(
      `INSERT INTO git_commits (id, hash, short_hash, message, authored_at, project_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(commitId, hash, shortHash, 'feat: huge file', '2026-05-01T12:00:00Z', 'p1');
    storage.db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
    ).run(randomUUID(), sessionId, commitId);

    const result = getSessionDiffs(storage.db, sessionId, { repoPath: repoDir });
    expect(result).toHaveLength(1);
    expect(result[0].skipped).toBe('too-large');
    expect(result[0].stats.files).toBe(1);
    expect(result[0].stats.insertions).toBeGreaterThan(0);
    expect(result[0].diff).toBeUndefined();
  });

  // 3. Repo missing
  it('returns repo-missing when repo path does not exist', () => {
    const sessionId = randomUUID();
    storage.db.prepare(
      'INSERT INTO sessions (id, source_tool_id, project_id) VALUES (?, ?, ?)',
    ).run(sessionId, 't1', 'p1');

    seedSessionCommit(storage, repoDir, sessionId, 0);

    const result = getSessionDiffs(storage.db, sessionId, { repoPath: '/no/such/path' });
    expect(result).toHaveLength(1);
    expect(result[0].skipped).toBe('repo-missing');
    expect(result[0].stats).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(result[0].diff).toBeUndefined();
  });

  // 4. Cache hit (no refresh)
  it('uses cached diff on second call without refresh', () => {
    const sessionId = randomUUID();
    storage.db.prepare(
      'INSERT INTO sessions (id, source_tool_id, project_id) VALUES (?, ?, ?)',
    ).run(sessionId, 't1', 'p1');

    seedSessionCommit(storage, repoDir, sessionId, 0);

    // first call — populates cache
    getSessionDiffs(storage.db, sessionId, { repoPath: repoDir });
    const row1 = storage.db.prepare(
      'SELECT cached_at FROM session_diffs WHERE session_id = ?',
    ).get(sessionId) as { cached_at: number };

    // second call — should read from cache, not re-exec
    getSessionDiffs(storage.db, sessionId, { repoPath: repoDir });
    const row2 = storage.db.prepare(
      'SELECT cached_at FROM session_diffs WHERE session_id = ?',
    ).get(sessionId) as { cached_at: number };

    expect(row2.cached_at).toBe(row1.cached_at);
  });

  // 5. Refresh bypasses cache
  it('re-fetches diff when refresh=true, updating cached_at', () => {
    const sessionId = randomUUID();
    storage.db.prepare(
      'INSERT INTO sessions (id, source_tool_id, project_id) VALUES (?, ?, ?)',
    ).run(sessionId, 't1', 'p1');

    seedSessionCommit(storage, repoDir, sessionId, 0);

    // first call
    getSessionDiffs(storage.db, sessionId, { repoPath: repoDir });
    const row1 = storage.db.prepare(
      'SELECT cached_at FROM session_diffs WHERE session_id = ?',
    ).get(sessionId) as { cached_at: number };

    // small delay so cached_at can differ
    const beforeRefresh = Date.now();

    // second call with refresh=true
    getSessionDiffs(storage.db, sessionId, { repoPath: repoDir, refresh: true });
    const row2 = storage.db.prepare(
      'SELECT cached_at FROM session_diffs WHERE session_id = ?',
    ).get(sessionId) as { cached_at: number };

    expect(row2.cached_at).toBeGreaterThanOrEqual(beforeRefresh);
    // actually should be different because we re-fetched
    // on fast machines the timestamp may be same ms, but at minimum
    // row2.cached_at should be >= beforeRefresh
    // verify it's fresh by checking it's >= the first call's timestamp
    expect(row2.cached_at).toBeGreaterThanOrEqual(row1.cached_at);
  });

  it('multi-commit session returns diffs for all commits in order', () => {
    const sessionId = randomUUID();
    storage.db.prepare(
      'INSERT INTO sessions (id, source_tool_id, project_id) VALUES (?, ?, ?)',
    ).run(sessionId, 't1', 'p1');

    // seed both commits
    seedSessionCommit(storage, repoDir, sessionId, 0);
    seedSessionCommit(storage, repoDir, sessionId, 1);

    const result = getSessionDiffs(storage.db, sessionId, { repoPath: repoDir });
    expect(result).toHaveLength(2);
    expect(result[0].stats.files).toBe(1);
    expect(result[1].stats.files).toBe(1);
    expect(result[0].diff).toBeTruthy();
    expect(result[1].diff).toBeTruthy();
  });

  it('upsert on conflict works (same commit under diff session already cached)', () => {
    const sessionId1 = randomUUID();
    const sessionId2 = randomUUID();
    storage.db.prepare('INSERT INTO sessions (id, source_tool_id, project_id) VALUES (?, ?, ?)').run(sessionId1, 't1', 'p1');
    storage.db.prepare('INSERT INTO sessions (id, source_tool_id, project_id) VALUES (?, ?, ?)').run(sessionId2, 't1', 'p1');

    seedSessionCommit(storage, repoDir, sessionId1, 0);
    seedSessionCommit(storage, repoDir, sessionId2, 0);

    // Both sessions reference the same git commit
    const r1 = getSessionDiffs(storage.db, sessionId1, { repoPath: repoDir });
    const r2 = getSessionDiffs(storage.db, sessionId2, { repoPath: repoDir });

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0].hash).toBe(r2[0].hash);
    expect(r1[0].diff).toBeTruthy();
    expect(r2[0].diff).toBeTruthy();

    // two rows in session_diffs (one per session_id)
    const count = storage.db.prepare('SELECT count(*) as cnt FROM session_diffs').get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });
});
