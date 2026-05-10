import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../src/storage.js';

const CLI = resolve(process.cwd(), 'dist/cli.js');

function mkRepo(): { dir: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-diff-repo-'));
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

function seedSessionAndCommit(storage: Storage, sessionId: string, hash: string): void {
  storage.db.prepare('INSERT INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t', 't', 'T');
  storage.db.prepare('INSERT INTO sessions (id, source_tool_id) VALUES (?, ?)').run(sessionId, 't');
  const commitId = randomUUID();
  storage.db
    .prepare('INSERT INTO git_commits (id, hash, short_hash, message) VALUES (?, ?, ?, ?)')
    .run(commitId, hash, hash.slice(0, 7), 'change');
  storage.db
    .prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
    )
    .run(randomUUID(), sessionId, commitId);
}

describe('cet diff CLI', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      execFileSync('npm', ['run', 'build'], { cwd: process.cwd(), encoding: 'utf-8', shell: true });
    }
  });

  let dataDir: string;
  let repo: ReturnType<typeof mkRepo>;
  let sessionId: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cli-diff-data-'));
    const storage = Storage.open({ dataDir });
    repo = mkRepo();
    sessionId = randomUUID();
    seedSessionAndCommit(storage, sessionId, repo.hash);
    storage.close();
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
    try {
      rmSync(repo.dir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('prints diff text', () => {
    const out = execFileSync(
      'node',
      [CLI, 'diff', sessionId, '--data-dir', dataDir, '--repo', repo.dir],
      { encoding: 'utf-8' },
    );
    expect(out).toContain('+b');
  });

  it('--stats prints counts only', () => {
    const out = execFileSync(
      'node',
      [CLI, 'diff', sessionId, '--data-dir', dataDir, '--repo', repo.dir, '--stats'],
      { encoding: 'utf-8' },
    );
    expect(out).toMatch(/1 file/);
    expect(out).toMatch(/\+1/);
    expect(out).not.toContain('+b\n');
  });

  it('--files lists changed files', () => {
    const out = execFileSync(
      'node',
      [CLI, 'diff', sessionId, '--data-dir', dataDir, '--repo', repo.dir, '--files'],
      { encoding: 'utf-8' },
    );
    expect(out).toContain('f.txt');
  });

  it('exits 1 on unknown session', () => {
    expect(() =>
      execFileSync(
        'node',
        [CLI, 'diff', 'missing-session-id', '--data-dir', dataDir, '--repo', repo.dir],
        { encoding: 'utf-8' },
      ),
    ).toThrow();
  });

  it('--commit filters by prefix', () => {
    const prefix = repo.hash.slice(0, 5);
    const out = execFileSync(
      'node',
      [
        CLI,
        'diff',
        sessionId,
        '--data-dir',
        dataDir,
        '--repo',
        repo.dir,
        '--commit',
        prefix,
        '--stats',
      ],
      { encoding: 'utf-8' },
    );
    expect(out).toContain(repo.hash.slice(0, 7));
  });
});
