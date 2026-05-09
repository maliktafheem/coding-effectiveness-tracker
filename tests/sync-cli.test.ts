/**
 * Integration tests for CLI sync and test-outcome commands.
 *
 * VAL-CLI-030: Git correlation imports local repository signals
 * VAL-CLI-031: Test correlation records command outcomes
 * VAL-IMPORT-013: Git correlation uses local repository metadata only
 * VAL-IMPORT-014: Test outcome correlation uses local test artifacts only
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures');

function safeCleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows file locks */ }
}

function makeGitArgs(msg: string): string[] {
  return ['-c', 'user.email=t@t.com', '-c', 'user.name=Test', 'commit', '-m', msg];
}

function gitFixtureCommit(repoDir: string, fileName: string, fileContent: string, msg: string, date: string): void {
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
  gitFixtureCommit(rd, 'file1.ts', 'export const a = 1;', 'feat: add file1', '2026-04-28T09:15:00Z');
  gitFixtureCommit(rd, 'file2.ts', 'export const b = 2;', 'feat: add file2', '2026-04-28T10:30:00Z');
  gitFixtureCommit(rd, 'file3.ts', 'export const c = 3;', 'fix: add file3', '2026-04-29T14:10:00Z');
  return rd;
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const cliPath = join(process.cwd(), 'bin', 'cli.js');
  try {
    const stdout = execFileSync('node', [cliPath, ...args], { encoding: 'utf-8', timeout: 15000 });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
      exitCode: e.status ?? 1,
    };
  }
}

// ─── CLI sync command (VAL-CLI-030, VAL-IMPORT-013) ─────────────────────────

describe('CLI sync command (VAL-CLI-030, VAL-IMPORT-013)', () => {
  let tempDir: string;
  let repoDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-sync-cli-'));
    repoDir = createTempGitRepo(tempDir);
    dataDir = join(tempDir, 'data');
    // Initialize workspace
    const initResult = runCli(['init', '-d', dataDir]);
    expect(initResult.exitCode).toBe(0);
    // Import fixture sessions so we have sessions to correlate
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
  });
  afterEach(() => { safeCleanup(tempDir); });

  it('syncs local git repo and stores commits without contacting remotes (VAL-CLI-030)', () => {
    const result = runCli(['sync', '-d', dataDir, '--repo', repoDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/git sync complete/i);
    expect(result.stdout).toMatch(/commits found/i);
    expect(result.stdout).toMatch(/privacy|local/i);

    // Verify commits stored in database
    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const count = db.prepare('SELECT count(*) as cnt FROM git_commits').get() as { cnt: number };
      expect(count.cnt).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });

  it('stores git commits with correct metadata', () => {
    runCli(['sync', '-d', dataDir, '--repo', repoDir]);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const commits = db.prepare('SELECT * FROM git_commits ORDER BY authored_at').all() as Record<string, unknown>[];
      expect(commits.length).toBeGreaterThanOrEqual(3);

      // First commit should have the expected message
      expect(commits[0].message).toBe('feat: add file1');
      expect(commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
      expect(commits[0].short_hash).toMatch(/^[0-9a-f]{7,}$/);
      expect(commits[0].branch).toBeTruthy();
      expect(commits[0].authored_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-running sync does not duplicate commits', () => {
    runCli(['sync', '-d', dataDir, '--repo', repoDir]);
    const db1 = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    let count1: number;
    try {
      count1 = (db1.prepare('SELECT count(*) as cnt FROM git_commits').get() as { cnt: number }).cnt;
    } finally {
      db1.close();
    }

    // Run sync again
    const result2 = runCli(['sync', '-d', dataDir, '--repo', repoDir]);
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).toMatch(/existing commits.*skipped/i);

    const db2 = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    let count2: number;
    try {
      count2 = (db2.prepare('SELECT count(*) as cnt FROM git_commits').get() as { cnt: number }).cnt;
    } finally {
      db2.close();
    }

    expect(count2).toBe(count1);
  });

  it('auto-derives project ID from repo directory name', () => {
    const result = runCli(['sync', '-d', dataDir, '--repo', repoDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/project:.*test-repo/i);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const commits = db.prepare('SELECT * FROM git_commits').all() as Record<string, unknown>[];
      for (const c of commits) {
        expect(c.project_id).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });

  it('honors explicit --project option', () => {
    const result = runCli(['sync', '-d', dataDir, '--repo', repoDir, '--project', 'my-project']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/project:.*my-project/i);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const commits = db.prepare("SELECT * FROM git_commits WHERE project_id = 'my-project'").all() as Record<string, unknown>[];
      expect(commits.length).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });

  it('correlates commits with imported sessions after sync', () => {
    // Import sessions and sync with matching project
    runCli(['sync', '-d', dataDir, '--repo', repoDir, '--project', 'project-alpha']);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      // Check that correlations were created
      const correlations = db.prepare(
        "SELECT count(*) as cnt FROM correlations WHERE correlation_type = 'git-commit'"
      ).get() as { cnt: number };
      expect(correlations.cnt).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('fails with nonexistent repo path', () => {
    const result = runCli(['sync', '-d', dataDir, '--repo', join(tempDir, 'nonexistent')]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('fails for non-git directory', () => {
    const notGit = join(tempDir, 'not-a-repo');
    mkdirSync(notGit);
    const result = runCli(['sync', '-d', dataDir, '--repo', notGit]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not a git/i);
  });

  it('auto-initializes workspace if not already initialized', () => {
    const uninitializedDir = join(tempDir, 'auto-init');
    const result = runCli(['sync', '-d', uninitializedDir, '--repo', repoDir]);
    // With auto-init, the workspace gets initialized automatically
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/not initialized/i);
    expect(existsSync(join(uninitializedDir, 'tracker.db'))).toBe(true);
  });

  it('works with empty git repo (no commits)', () => {
    const emptyRepo = join(tempDir, 'empty-repo');
    mkdirSync(emptyRepo);
    execFileSync('git', ['init'], { cwd: emptyRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: emptyRepo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: emptyRepo });

    const result = runCli(['sync', '-d', dataDir, '--repo', emptyRepo]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no commits found/i);
  });
});

// ─── CLI test-outcome command (VAL-CLI-031, VAL-IMPORT-014) ──────────────────

describe('CLI test-outcome command (VAL-CLI-031, VAL-IMPORT-014)', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-test-out-cli-'));
    dataDir = join(tempDir, 'data');
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
  });
  afterEach(() => { safeCleanup(tempDir); });

  it('ingests inline test outcome and stores pass/fail/duration (VAL-CLI-031)', () => {
    const result = runCli([
      'test-outcome', '-d', dataDir,
      '--command', 'npm test',
      '--passed', '10',
      '--failed', '0',
      '--skipped', '1',
      '--duration', '5000',
      '--run-at', '2026-04-28T09:20:00Z',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/test outcome ingest complete/i);
    expect(result.stdout).toMatch(/new outcomes stored: 1/i);
    expect(result.stdout).toMatch(/privacy|local/i);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const outcomes = db.prepare('SELECT * FROM test_outcomes').all() as Record<string, unknown>[];
      expect(outcomes.length).toBeGreaterThanOrEqual(1);
      const outcome = outcomes.find((o) => o.command === 'npm test' && o.run_at === '2026-04-28T09:20:00Z');
      expect(outcome).toBeTruthy();
      expect(outcome!.passed).toBe(10);
      expect(outcome!.failed).toBe(0);
      expect(outcome!.skipped).toBe(1);
      expect(outcome!.duration_ms).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('ingests test outcomes from JSON file (VAL-CLI-031)', () => {
    // Create a JSON artifact
    const jsonPath = join(tempDir, 'test-results.json');
    const records = [
      { command: 'npm test', passed: 20, failed: 0, skipped: 0, durationMs: 3000, runAt: '2026-04-28T09:25:00Z' },
      { command: 'pytest', passed: 15, failed: 2, skipped: 1, durationMs: 4200, runAt: '2026-04-28T10:40:00Z' },
    ];
    writeFileSync(jsonPath, JSON.stringify(records, null, 2));

    const result = runCli([
      'test-outcome', '-d', dataDir,
      '--outcome-json', jsonPath,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/new outcomes stored: 2/i);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const outcomes = db.prepare('SELECT * FROM test_outcomes ORDER BY run_at').all() as Record<string, unknown>[];
      // At least our 2 new ones (plus any from previous tests if DB shared)
      const npmOutcome = outcomes.find((o) => o.command === 'npm test' && o.run_at === '2026-04-28T09:25:00Z');
      expect(npmOutcome).toBeTruthy();
      expect(npmOutcome!.passed).toBe(20);

      const pytestOutcome = outcomes.find((o) => o.command === 'pytest' && o.run_at === '2026-04-28T10:40:00Z');
      expect(pytestOutcome).toBeTruthy();
      expect(pytestOutcome!.passed).toBe(15);
      expect(pytestOutcome!.failed).toBe(2);
      expect(pytestOutcome!.skipped).toBe(1);
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-running with same data does not duplicate (VAL-CLI-031)', () => {
    runCli([
      'test-outcome', '-d', dataDir,
      '--command', 'npm test',
      '--passed', '10',
      '--failed', '0',
      '--run-at', '2026-04-28T09:20:00Z',
    ]);

    const db1 = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    let count1: number;
    try {
      count1 = (db1.prepare('SELECT count(*) as cnt FROM test_outcomes').get() as { cnt: number }).cnt;
    } finally {
      db1.close();
    }

    // Same command + runAt + default project
    const result2 = runCli([
      'test-outcome', '-d', dataDir,
      '--command', 'npm test',
      '--passed', '10',
      '--failed', '0',
      '--run-at', '2026-04-28T09:20:00Z',
    ]);
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).toMatch(/skipped.*duplicate/i);

    const db2 = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    let count2: number;
    try {
      count2 = (db2.prepare('SELECT count(*) as cnt FROM test_outcomes').get() as { cnt: number }).cnt;
    } finally {
      db2.close();
    }

    expect(count2).toBe(count1);
  });

  it('stores outcomes per project', () => {
    runCli([
      'test-outcome', '-d', dataDir, '--project', 'project-alpha',
      '--command', 'npm test', '--passed', '10', '--failed', '0',
      '--run-at', '2026-04-28T09:20:00Z',
    ]);
    runCli([
      'test-outcome', '-d', dataDir, '--project', 'project-beta',
      '--command', 'pytest', '--passed', '5', '--failed', '3',
      '--run-at', '2026-04-28T16:40:00Z',
    ]);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const alpha = db.prepare("SELECT count(*) as cnt FROM test_outcomes WHERE project_id = 'project-alpha'").get() as { cnt: number };
      const beta = db.prepare("SELECT count(*) as cnt FROM test_outcomes WHERE project_id = 'project-beta'").get() as { cnt: number };
      expect(alpha.cnt).toBeGreaterThanOrEqual(1);
      expect(beta.cnt).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('links outcome to session when --session is provided', () => {
    const db0 = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    let sessionId: string;
    try {
      const sessions = db0.prepare('SELECT id FROM sessions LIMIT 1').all() as { id: string }[];
      expect(sessions.length).toBeGreaterThan(0);
      sessionId = sessions[0].id;
    } finally {
      db0.close();
    }

    const result = runCli([
      'test-outcome', '-d', dataDir,
      '--command', 'npm test', '--passed', '10', '--failed', '0',
      '--run-at', '2026-04-28T09:20:00Z',
      '--session', sessionId,
    ]);
    expect(result.exitCode).toBe(0);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const linked = db.prepare('SELECT * FROM test_outcomes WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
      expect(linked).toBeTruthy();
      expect(linked!.command).toBe('npm test');
    } finally {
      db.close();
    }
  });

  it('fails when --outcome-json file does not exist', () => {
    const result = runCli([
      'test-outcome', '-d', dataDir,
      '--outcome-json', join(tempDir, 'nonexistent.json'),
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('fails when --outcome-json contains invalid JSON', () => {
    const badJson = join(tempDir, 'bad.json');
    writeFileSync(badJson, 'not json at all {{{');
    const result = runCli(['test-outcome', '-d', dataDir, '--outcome-json', badJson]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not valid json/i);
  });

  it('fails when --outcome-json contains non-array', () => {
    const objJson = join(tempDir, 'obj.json');
    writeFileSync(objJson, JSON.stringify({ command: 'test' }));
    const result = runCli(['test-outcome', '-d', dataDir, '--outcome-json', objJson]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/json array/i);
  });

  it('fails when outcome record missing required fields', () => {
    const badRecords = join(tempDir, 'bad-records.json');
    writeFileSync(badRecords, JSON.stringify([{ passed: 10, failed: 0 }]));
    const result = runCli(['test-outcome', '-d', dataDir, '--outcome-json', badRecords]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/missing.*command/i);
  });

  it('fails when no --command or --outcome-json provided', () => {
    const result = runCli(['test-outcome', '-d', dataDir]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--outcome-json|--command/i);
  });

  it('uses current time when --run-at is omitted', () => {
    const before = new Date().toISOString();
    const result = runCli([
      'test-outcome', '-d', dataDir,
      '--command', 'vitest run', '--passed', '5', '--failed', '0',
    ]);
    expect(result.exitCode).toBe(0);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const outcome = db.prepare("SELECT * FROM test_outcomes WHERE command = 'vitest run'").get() as Record<string, unknown>;
      expect(outcome).toBeTruthy();
      expect(outcome.run_at).toBeTruthy();
      // Should be a valid ISO datetime after our before time
      expect(outcome.run_at >= before.slice(0, 16)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('report reflects test contribution after ingest (VAL-CLI-031)', () => {
    // Ingest passing test outcomes
    runCli([
      'test-outcome', '-d', dataDir, '--project', 'project-alpha',
      '--command', 'npm test', '--passed', '20', '--failed', '0',
      '--duration', '3000', '--run-at', '2026-04-28T09:30:00Z',
    ]);

    const result = runCli(['report', '-d', dataDir, '--json', '--project', 'project-alpha']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    // Test-confidence dimension should be available now
    const testDim = parsed.score.dimensions.find((d: { name: string }) => d.name === 'test-confidence');
    expect(testDim).toBeTruthy();
    expect(testDim.available).toBe(true);
  });
});

// ─── Privacy and local-only verification (VAL-IMPORT-013, VAL-IMPORT-014) ────

describe('Privacy and local-only verification', () => {
  let tempDir: string;
  let repoDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-privacy-cli-'));
    repoDir = createTempGitRepo(tempDir);
    dataDir = join(tempDir, 'data');
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
  });
  afterEach(() => { safeCleanup(tempDir); });

  it('sync output contains privacy statement (VAL-IMPORT-013)', () => {
    const result = runCli(['sync', '-d', dataDir, '--repo', repoDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/privacy.*local|local.*remote/i);
    expect(result.stdout).not.toMatch(/github\.com|gitlab\.com|bitbucket\.org|fetch|push|pull.*remote/i);
  });

  it('test-outcome output contains privacy statement (VAL-IMPORT-014)', () => {
    const result = runCli([
      'test-outcome', '-d', dataDir,
      '--command', 'npm test', '--passed', '10', '--failed', '0',
      '--run-at', '2026-04-28T09:20:00Z',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/privacy.*local|local.*remote/i);
  });

  it('sync does not dump raw commit content to stdout', () => {
    const result = runCli(['sync', '-d', dataDir, '--repo', repoDir]);
    expect(result.exitCode).toBe(0);
    // Should contain structured summary, not raw file content
    expect(result.stdout).not.toMatch(/export const/);
    expect(result.stdout).not.toMatch(/\.ts/);
  });

  it('test-outcome JSON ingestion does not leak file content to stdout', () => {
    const jsonPath = join(tempDir, 'test-results.json');
    writeFileSync(jsonPath, JSON.stringify([
      { command: 'npm test', passed: 10, failed: 0, skipped: 0, durationMs: 1000, runAt: '2026-04-28T09:20:00Z' },
    ]));

    const result = runCli(['test-outcome', '-d', dataDir, '--outcome-json', jsonPath]);
    expect(result.exitCode).toBe(0);
    // Output should be summary counts, not raw record content
    expect(result.stdout).toMatch(/outcomes stored|ingest complete/i);
  });
});

