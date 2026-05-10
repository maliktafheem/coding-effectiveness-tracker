import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../src/storage.js';

const CLI = resolve(process.cwd(), 'dist/cli.js');
const FIXTURE = resolve(process.cwd(), 'tests/fixtures/gh-pr-sample.json');

function mkRepo(): { dir: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cet-syncpr-repo-'));
  const run = (c: string, a: string[]): string =>
    execFileSync(c, a, { cwd: dir, encoding: 'utf-8' });
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.email', 't@t']);
  run('git', ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'f.txt'), 'hello\n');
  run('git', ['add', 'f.txt']);
  run('git', ['commit', '-q', '-m', 'init']);
  const hash = run('git', ['rev-parse', 'HEAD']).trim();
  return { dir, hash };
}

describe('cet sync --pr CLI', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      execFileSync('npm', ['run', 'build'], { cwd: process.cwd(), encoding: 'utf-8', shell: true });
    }
  });

  let dataDir: string;
  let repo: ReturnType<typeof mkRepo>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cet-syncpr-data-'));
    repo = mkRepo();

    // Seed a session + git commit + git-commit correlation
    // that matches the fixture's first PR commit
    const storage = Storage.open({ dataDir });
    storage.db.prepare('INSERT INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t', 't', 'T');
    const sessionId = randomUUID();
    storage.db.prepare('INSERT INTO sessions (id, source_tool_id) VALUES (?, ?)').run(sessionId, 't');
    const commitId = randomUUID();
    // Use exact hash from fixture
    storage.db.prepare('INSERT INTO git_commits (id, hash, short_hash, message) VALUES (?, ?, ?, ?)')
      .run(commitId, 'abc123def456abc123def456abc123def456abcd', 'abc123d', 'seeded');
    storage.db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
    ).run(randomUUID(), sessionId, commitId);
    storage.close();
  });

  afterEach(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(repo.dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('--pr with fixture runner writes pr-outcome correlation', () => {
    execFileSync(
      'node',
      [CLI, 'sync', '--pr', '--data-dir', dataDir, '--repo', repo.dir],
      {
        encoding: 'utf-8',
        env: { ...process.env, CET_TEST_GH_FIXTURE: FIXTURE },
      },
    );

    const s = Storage.open({ dataDir });
    try {
      const prCorr = s.db.prepare(
        "SELECT target_id, metadata_json FROM correlations WHERE correlation_type = 'pr-outcome'",
      ).all() as { target_id: string; metadata_json: string }[];
      expect(prCorr.length).toBe(1);
      expect(prCorr[0].target_id).toBe('42');
      const meta = JSON.parse(prCorr[0].metadata_json);
      expect(meta.state).toBe('merged');
    } finally {
      s.close();
    }
  });

  it('sync without --pr does NOT call PR logic', () => {
    execFileSync(
      'node',
      [CLI, 'sync', '--data-dir', dataDir, '--repo', repo.dir],
      { encoding: 'utf-8' },
    );
    const s = Storage.open({ dataDir });
    try {
      const count = (s.db.prepare(
        "SELECT COUNT(*) as c FROM correlations WHERE correlation_type = 'pr-outcome'",
      ).get() as { c: number }).c;
      expect(count).toBe(0);
    } finally {
      s.close();
    }
  });

  it('--pr prints helpful error if gh missing (no fixture, likely no gh on CI)', () => {
    // Without CET_TEST_GH_FIXTURE, DefaultGhRunner is used. On CI without gh,
    // available() returns false and handler prints friendly error.
    // Skip assertion if gh is actually installed (local dev).
    let ghInstalled = false;
    try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); ghInstalled = true; } catch { /* */ }
    if (ghInstalled) return; // cannot test this path locally

    try {
      execFileSync(
        'node',
        [CLI, 'sync', '--pr', '--data-dir', dataDir, '--repo', repo.dir],
        { encoding: 'utf-8' },
      );
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      const combined = (e.stdout ?? '') + (e.stderr ?? '');
      expect(combined).toMatch(/gh.*CLI.*not installed/i);
      expect(e.status).toBe(1);
    }
  });
});
