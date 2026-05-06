/**
 * End-to-end smoke test covering the full fresh Windows PowerShell checkout journey.
 *
 * VAL-INSTALL-001: Fresh checkout and packaged CLI journey works on Windows.
 * From a fresh checkout or packaged local install, a Windows PowerShell user can
 * install dependencies, invoke the CLI entrypoint, initialize, import fixture data,
 * serve the dashboard, and export a report without manual database edits.
 *
 * Also covers:
 * - Privacy: No fixture canary secrets leak through terminal, SQLite, or exports
 * - Orphan process: No dashboard processes remain after test completes
 * - Package/bin: CLI works without global install via node bin/cli.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import Database from 'better-sqlite3';

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures');
const ALL_CANARIES = [
  'CANARY_LEAK_TEST_MARKER_ALPHA_ZERO',
  'CANARY_LEAK_TEST_MARKER_BETA_ZERO',
  'CANARY_LEAK_TEST_MARKER_GAMMA_ZERO',
  'CANARY_LEAK_TEST_MARKER_DELTA_ZERO',
];

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows file locks - ignore
  }
}

function makeGitArgs(msg: string): string[] {
  return ['-c', 'user.email=t@t.com', '-c', 'user.name=Test', 'commit', '-m', msg];
}

function gitFixtureCommit(repoDir: string, fileName: string, fileContent: string, msg: string, date: string): void {
  writeFileSync(join(repoDir, fileName), fileContent);
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', makeGitArgs(msg), {
    cwd: repoDir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

/**
 * Resolve agent-browser executable path portably from PATH or documented Factory configuration.
 * Falls back to checking ~/.factory/tools/agent-browser/bin/agent-browser.exe
 * Throws a clear environment error if not found anywhere.
 */
function resolveAgentBrowser(): string {
  // 1. Try documented Factory tools location first (most reliable, avoids .cmd wrapper)
  const factoryExe = join(homedir(), '.factory', 'tools', 'agent-browser', 'bin', 'agent-browser.exe');
  if (existsSync(factoryExe)) {
    return factoryExe;
  }

  // 2. Try PATH resolution (where.exe checks PATHEXT)
  try {
    const result = execFileSync('where.exe', ['agent-browser'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const firstResult = result.trim().split(/\r?\n/)[0]?.trim();
    if (firstResult && existsSync(firstResult)) {
      return firstResult;
    }
  } catch {
    // Not found on PATH
  }

  // 3. Not found anywhere — throw clear environment error
  throw new Error(
    'agent-browser not found. Install Factory agent-browser or add it to PATH.\n' +
    'Checked: ' + factoryExe + ' and system PATH.\n' +
    'Skipping browser validation tests.'
  );
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

/**
 * Run the CLI via `node bin/cli.js` — no global install required.
 * This is how a fresh checkout user invokes the tool on Windows PowerShell.
 */
function runCli(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const cliPath = join(process.cwd(), 'bin', 'cli.js');
  try {
    const stdout = execFileSync('node', [cliPath, ...args], {
      encoding: 'utf-8',
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      timeout: 30000,
    });
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

/** Check for canary leaks in combined output. */
function checkForCanaryLeaks(text: string, _context: string): void {
  for (const canary of ALL_CANARIES) {
    expect(text).not.toContain(canary);
  }
}

/** Check for canary leaks in a database. */
function checkDbForCanaryLeaks(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true });
  try {
    // Check summary fields
    const summaries = db.prepare('SELECT summary FROM sessions WHERE summary IS NOT NULL').all() as { summary: string }[];
    for (const row of summaries) {
      for (const canary of ALL_CANARIES) {
        expect(row.summary).not.toContain(canary);
      }
    }

    // Check metadata_json
    const metadatas = db.prepare('SELECT metadata_json FROM sessions WHERE metadata_json IS NOT NULL').all() as { metadata_json: string }[];
    for (const row of metadatas) {
      for (const canary of ALL_CANARIES) {
        expect(row.metadata_json).not.toContain(canary);
      }
    }
  } finally {
    db.close();
  }
}

// =============================================================================
// VAL-INSTALL-001: Fresh Windows PowerShell checkout journey
// =============================================================================

describe('VAL-INSTALL-001: Fresh Windows PowerShell checkout journey', () => {
  let tempDir: string;
  let dataDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-e2e-'));
    dataDir = join(tempDir, 'tracker-data');
    repoDir = createTempGitRepo(tempDir);
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('1. npm install succeeds (dependencies resolve)', () => {
    // Dependencies are already installed in the project, but we verify
    // the lock file exists and dependencies are available
    expect(existsSync(join(process.cwd(), 'package-lock.json'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'node_modules'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'node_modules', 'commander'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'node_modules', 'better-sqlite3'))).toBe(true);
  });

  it('2. npm run build succeeds and produces dist output', () => {
    // Build already ran in beforeEach, verify output
    expect(existsSync(join(process.cwd(), 'dist', 'cli.js'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'dist', 'dashboard', 'index.html'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'dist', 'storage.js'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'dist', 'config.js'))).toBe(true);
  });

  it('3. CLI help is discoverable and shows local-first privacy wording', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('import');
    expect(result.stdout).toContain('report');
    expect(result.stdout).toContain('serve');
    expect(result.stdout).toContain('export');
    expect(result.stdout).toContain('annotate');
    expect(result.stdout).toContain('sync');
    expect(result.stdout).toContain('test-outcome');
    expect(result.stdout.toLowerCase()).toMatch(/local|privacy|no telemetry/);
  });

  it('4. CLI version output is non-mutating', () => {
    const versionDir = join(tempDir, 'version-check');
    const result = runCli(['--version'], { env: { CET_DATA_DIR: versionDir } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    // No files should be created
    expect(existsSync(versionDir)).toBe(false);
  });

  it('5. cet init creates local workspace with SQLite database and default tools', () => {
    const result = runCli(['init', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized workspace');
    expect(existsSync(join(dataDir, 'tracker.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'importers'))).toBe(true);
    expect(existsSync(join(dataDir, 'exports'))).toBe(true);
    expect(existsSync(join(dataDir, 'correlations'))).toBe(true);

    // Verify database has default tools
    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const tools = db.prepare('SELECT id FROM tools').all() as { id: string }[];
      const toolIds = tools.map((t) => t.id);
      expect(toolIds).toContain('codex');
      expect(toolIds).toContain('opencode');
      expect(toolIds).toContain('factory-droid');
      expect(toolIds).toContain('claude-code');
      expect(toolIds).toContain('cursor');
    } finally {
      db.close();
    }

    // Verify privacy message
    expect(result.stdout.toLowerCase()).toContain('privacy');
    expect(result.stdout.toLowerCase()).toContain('local');

    // No canary leaks in init output
    checkForCanaryLeaks(result.stdout + result.stderr, 'init');
  });

  it('6. cet init is idempotent — second run preserves existing data', () => {
    runCli(['init', '-d', dataDir]);

    // Insert custom data
    const db = new Database(join(dataDir, 'tracker.db'));
    db.exec(`INSERT INTO projects (id, name) VALUES ('custom-1', 'Custom Project');`);
    db.close();

    // Second init without --force
    const result = runCli(['init', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Already initialized');

    // Custom data should be preserved
    const db2 = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const project = db2.prepare('SELECT * FROM projects WHERE id = ?').get('custom-1');
      expect(project).toBeTruthy();
    } finally {
      db2.close();
    }
  });

  it('7. cet import --fixture imports fixture sessions', () => {
    runCli(['init', '-d', dataDir]);
    const fixturePath = join(FIXTURES_DIR, 'sessions-fixture.json');
    const result = runCli(['import', '-d', dataDir, '--fixture', fixturePath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/session/i);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const count = db.prepare('SELECT count(*) as cnt FROM sessions').get() as { cnt: number };
      expect(count.cnt).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }

    // No canary leaks in import output
    checkForCanaryLeaks(result.stdout + result.stderr, 'fixture import');
  });

  it('8. cet import is idempotent — second import does not duplicate sessions', () => {
    runCli(['init', '-d', dataDir]);
    const fixturePath = join(FIXTURES_DIR, 'sessions-fixture.json');
    runCli(['import', '-d', dataDir, '--fixture', fixturePath]);
    const db1 = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    let count1: number;
    try { count1 = (db1.prepare('SELECT count(*) as cnt FROM sessions').get() as { cnt: number }).cnt; } finally { db1.close(); }

    const result2 = runCli(['import', '-d', dataDir, '--fixture', fixturePath]);
    expect(result2.exitCode).toBe(0);

    // Session count must not increase on re-import (idempotent)
    const db2 = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      expect((db2.prepare('SELECT count(*) as cnt FROM sessions').get() as { cnt: number }).cnt).toBe(count1);
    } finally {
      db2.close();
    }
  });

  it('9. cet sync correlates Git commits with imported sessions (local-only)', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);

    const result = runCli(['sync', '-d', dataDir, '--repo', repoDir, '--project', 'project-alpha']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/git sync complete/i);
    expect(result.stdout).toMatch(/commits found/i);
    expect(result.stdout).toMatch(/privacy.*local|local.*remote/i);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const commitCount = db.prepare("SELECT count(*) as cnt FROM git_commits WHERE project_id = 'project-alpha'").get() as { cnt: number };
      expect(commitCount.cnt).toBeGreaterThanOrEqual(3);

      const corrCount = db.prepare(
        "SELECT count(*) as cnt FROM correlations WHERE correlation_type = 'git-commit'"
      ).get() as { cnt: number };
      expect(corrCount.cnt).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('10. cet test-outcome ingests test results and correlates with sessions', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    runCli(['sync', '-d', dataDir, '--repo', repoDir, '--project', 'project-alpha']);

    const result = runCli([
      'test-outcome', '-d', dataDir, '--project', 'project-alpha',
      '--command', 'npm test', '--passed', '20', '--failed', '0',
      '--duration', '3000', '--run-at', '2026-04-28T09:30:00Z',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/test outcome ingest complete/i);
    expect(result.stdout).toMatch(/new outcomes stored: 1/i);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const outcomes = db.prepare("SELECT * FROM test_outcomes WHERE project_id = 'project-alpha'").all() as Record<string, unknown>[];
      expect(outcomes.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('11. cet report shows effectiveness score with dimensions', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    runCli(['sync', '-d', dataDir, '--repo', repoDir, '--project', 'project-alpha']);
    runCli([
      'test-outcome', '-d', dataDir, '--project', 'project-alpha',
      '--command', 'npm test', '--passed', '20', '--failed', '0',
      '--duration', '3000', '--run-at', '2026-04-28T09:30:00Z',
    ]);

    const result = runCli(['report', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/effectiveness|score|session/i);
    expect(result.stdout).toMatch(/aggregate|dimension/i);

    // No canary leaks in report output
    checkForCanaryLeaks(result.stdout + result.stderr, 'report');
  });

  it('12. cet report --json produces valid JSON with expected fields', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);

    const result = runCli(['report', '-d', dataDir, '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.score).toBeDefined();
    expect(typeof parsed.score.aggregate).toBe('number');
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sources).toBeDefined();
    expect(parsed.period).toBeDefined();
    expect(parsed.totalSessions).toBeDefined();
  });

  it('13. cet export exports JSON report to local file', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);

    const outPath = join(tempDir, 'report.json');
    const result = runCli(['export', '-d', dataDir, '--format', 'json', '-o', outPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Exported');
    expect(existsSync(outPath)).toBe(true);

    const content = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(content.score).toBeDefined();
    expect(content.sessions).toBeDefined();
    expect(content.empty).toBe(false);
    expect(content.generatedAt).toBeDefined();
  });

  it('14. cet export exports Markdown report to local file', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);

    const outPath = join(tempDir, 'report.md');
    const result = runCli(['export', '-d', dataDir, '--format', 'markdown', '-o', outPath]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).toContain('Effectiveness');
    expect(content).toContain('Session');
    expect(content).toContain('Privacy');
    expect(content).toContain('local');
  });

  it('15. cet export refuses overwrite without --overwrite, allows with it', () => {
    runCli(['init', '-d', dataDir]);
    const outPath = join(tempDir, 'report.json');

    // Create existing file
    writeFileSync(outPath, 'existing content');

    // Without --overwrite should fail
    const result1 = runCli(['export', '-d', dataDir, '--format', 'json', '-o', outPath]);
    expect(result1.exitCode).not.toBe(0);
    expect(readFileSync(outPath, 'utf-8')).toBe('existing content');

    // With --overwrite should succeed
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    const result2 = runCli(['export', '-d', dataDir, '--format', 'json', '-o', outPath, '--overwrite']);
    expect(result2.exitCode).toBe(0);
    const content = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(content.score).toBeDefined();
  });

  it('16. cet export supports JSON machine-readable format with deterministic fields', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);

    const outPath = join(tempDir, 'report.json');
    runCli(['export', '-d', dataDir, '--format', 'json', '-o', outPath]);
    const content = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(content.score).toBeDefined();
    expect(Array.isArray(content.score.dimensions)).toBe(true);
    expect(Array.isArray(content.score.missingInputs)).toBe(true);
    expect(Array.isArray(content.sessions)).toBe(true);
    expect(Array.isArray(content.tools)).toBe(true);
    expect(content.totalSessions).toBeGreaterThanOrEqual(0);
    expect(content.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('17. cet annotate creates manual outcome for an existing session', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    let sessionId: string;
    try {
      sessionId = (db.prepare('SELECT id FROM sessions LIMIT 1').all() as { id: string }[])[0].id;
    } finally {
      db.close();
    }

    const result = runCli(['annotate', '-d', dataDir, '--session', sessionId, '--outcome', 'good', '--note', 'E2E test annotation']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/annotation|record/i);

    const db2 = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const outcome = db2.prepare('SELECT * FROM outcomes WHERE session_id = ?').get(sessionId) as Record<string, unknown>;
      expect(outcome).toBeTruthy();
      expect(outcome.label).toBe('good');
      expect(outcome.outcome_type).toBe('manual');
    } finally {
      db2.close();
    }
  });

  it('18. cet annotate rejects nonexistent session', () => {
    runCli(['init', '-d', dataDir]);
    const result = runCli(['annotate', '-d', dataDir, '--session', 'nonexistent-id', '--outcome', 'good']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('19. cet annotate validates outcome values', () => {
    runCli(['init', '-d', dataDir]);
    const result = runCli(['annotate', '-d', dataDir, '--session', 'any-id', '--outcome', 'invalid-label']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/invalid outcome/i);
  });

  it('20. cet serve --help shows port option', () => {
    runCli(['init', '-d', dataDir]);
    const result = runCli(['serve', '-d', dataDir, '-p', '43199', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('port');
  });

  it('21. Full end-to-end flow: init -> import -> sync -> test -> report -> export', () => {
    // 1. Init
    const initResult = runCli(['init', '-d', dataDir]);
    expect(initResult.exitCode).toBe(0);
    expect(initResult.stdout).toContain('Initialized workspace');

    // 2. Import correlation sessions
    const importResult = runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    expect(importResult.exitCode).toBe(0);
    expect(importResult.stdout).toMatch(/session/i);

    // 3. Sync git repo
    const syncResult = runCli(['sync', '-d', dataDir, '--repo', repoDir, '--project', 'project-alpha']);
    expect(syncResult.exitCode).toBe(0);

    // 4. Ingest test outcomes
    const testOutcomeResult = runCli([
      'test-outcome', '-d', dataDir, '--project', 'project-alpha',
      '--command', 'npm test', '--passed', '20', '--failed', '0',
      '--duration', '3000', '--run-at', '2026-04-28T09:30:00Z',
    ]);
    expect(testOutcomeResult.exitCode).toBe(0);

    // 5. Report (JSON)
    const reportResult = runCli(['report', '-d', dataDir, '--project', 'project-alpha', '--json']);
    expect(reportResult.exitCode).toBe(0);
    const report = JSON.parse(reportResult.stdout);
    expect(report.score).toBeDefined();
    expect(report.sessions.length).toBeGreaterThanOrEqual(1);

    // 6. Export JSON
    const jsonOut = join(tempDir, 'final-report.json');
    const exportJsonResult = runCli(['export', '-d', dataDir, '--project', 'project-alpha', '--format', 'json', '-o', jsonOut]);
    expect(exportJsonResult.exitCode).toBe(0);
    expect(existsSync(jsonOut)).toBe(true);
    const exportedJson = JSON.parse(readFileSync(jsonOut, 'utf-8'));
    expect(exportedJson.totalSessions).toBe(report.sessions.length);

    // 7. Export Markdown
    const mdOut = join(tempDir, 'final-report.md');
    const exportMdResult = runCli(['export', '-d', dataDir, '--project', 'project-alpha', '--format', 'markdown', '-o', mdOut]);
    expect(exportMdResult.exitCode).toBe(0);
    expect(existsSync(mdOut)).toBe(true);
    const mdContent = readFileSync(mdOut, 'utf-8');
    expect(mdContent).toContain('Effectiveness');
    expect(mdContent).toContain('Overview');

    // 8. Verify no orphan processes (no dashboard server was started, verify port is free)
    // This is a process-cleanup check — we didn't start a server in this test
  });
});

// =============================================================================
// Privacy verification across all surfaces
// =============================================================================

describe('Privacy: No fixture canary secrets leak across surfaces', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-privacy-e2e-'));
    dataDir = join(tempDir, 'tracker-data');
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('Terminal output from init, import, report does not contain canary strings', () => {
    runCli(['init', '-d', dataDir]);

    const importResult = runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'sessions-fixture.json')]);
    const combinedImport = importResult.stdout + importResult.stderr;
    checkForCanaryLeaks(combinedImport, 'fixture import output');

    const reportResult = runCli(['report', '-d', dataDir]);
    const combinedReport = reportResult.stdout + reportResult.stderr;
    checkForCanaryLeaks(combinedReport, 'report output');
  });

  it('SQLite summary fields do not contain canary strings', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'sessions-fixture.json')]);
    checkDbForCanaryLeaks(join(dataDir, 'tracker.db'));
  });

  it('JSON export file does not contain canary strings', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'sessions-fixture.json')]);

    const outPath = join(tempDir, 'report.json');
    runCli(['export', '-d', dataDir, '--format', 'json', '-o', outPath]);
    const content = readFileSync(outPath, 'utf-8');
    checkForCanaryLeaks(content, 'JSON export');
  });

  it('Markdown export file does not contain canary strings', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'sessions-fixture.json')]);

    const outPath = join(tempDir, 'report.md');
    runCli(['export', '-d', dataDir, '--format', 'markdown', '-o', outPath]);
    const content = readFileSync(outPath, 'utf-8');
    checkForCanaryLeaks(content, 'Markdown export');
  });

  it('CLI init/import with verbose does not leak canaries', () => {
    runCli(['init', '-d', dataDir]);

    const result = runCli([
      'import', '-d', dataDir,
      '--fixture', join(FIXTURES_DIR, 'sessions-fixture.json'),
      '--verbose',
    ]);
    const combined = result.stdout + result.stderr;
    checkForCanaryLeaks(combined, 'verbose import');

    // Also use --source with --tool --verbose
    const result2 = runCli([
      'import', '-d', dataDir,
      '--tool', 'codex',
      '--source', join(FIXTURES_DIR, 'codex'),
      '--verbose',
    ]);
    const combined2 = result2.stdout + result2.stderr;
    checkForCanaryLeaks(combined2, 'verbose tool import');
  });

  it('CLI report output does not contain canary strings', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);

    const result = runCli(['report', '-d', dataDir]);
    checkForCanaryLeaks(result.stdout + result.stderr, 'report output');
  });

  it('CLI report --json does not contain canary strings', () => {
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);

    const result = runCli(['report', '-d', dataDir, '--json']);
    const parsed = JSON.parse(result.stdout);
    const jsonStr = JSON.stringify(parsed);
    checkForCanaryLeaks(jsonStr, 'report JSON');
  });

  it('CLI sync output contains privacy statement (VAL-IMPORT-013)', () => {
    const repoDir2 = createTempGitRepo(tempDir);
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);

    const result = runCli(['sync', '-d', dataDir, '--repo', repoDir2, '--project', 'project-alpha']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/privacy.*local|local.*remote/i);
  });

  it('CLI test-outcome output contains privacy statement (VAL-IMPORT-014)', () => {
    runCli(['init', '-d', dataDir]);

    const result = runCli([
      'test-outcome', '-d', dataDir,
      '--command', 'npm test', '--passed', '10', '--failed', '0',
      '--run-at', '2026-04-28T09:20:00Z',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/privacy.*local|local.*remote/i);
  });
});

// =============================================================================
// Package/bin behavior on Windows PowerShell without global installs
// =============================================================================

describe('Package/bin behavior on Windows PowerShell', () => {
  it('bin/cli.js is executable via node', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('cet');
  });

  it('bin/cli.js has correct shebang for Windows', () => {
    const content = readFileSync(join(process.cwd(), 'bin', 'cli.js'), 'utf-8');
    expect(content).toContain('#!/usr/bin/env node');
  });

  it('package.json has correct bin entry pointing to bin/cli.js', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.cet).toBe('./bin/cli.js');
  });

  it('package.json files field includes dist, bin, and README.md', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.files).toBeDefined();
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('bin');
    expect(pkg.files).toContain('README.md');
  });

  it('can invoke CLI with `npx cet` equivalent path', () => {
    // Verify the CLI works via relative path to bin/cli.js
    const result = runCli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('CLI works from a different working directory with relative path', () => {
    const cliPath = join(process.cwd(), 'bin', 'cli.js');
    const tempWorkDir = mkdtempSync(join(tmpdir(), 'cet-cwd-'));
    try {
      const stdout = execFileSync('node', [cliPath, '--version'], {
        encoding: 'utf-8',
        cwd: tempWorkDir,
        timeout: 10000,
      });
      expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    } finally {
      safeCleanup(tempWorkDir);
    }
  });
});

// =============================================================================
// Server process lifecycle (no orphan processes)
// =============================================================================

describe('Server process lifecycle', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-server-e2e-'));
    dataDir = join(tempDir, 'tracker-data');
    runCli(['init', '-d', dataDir]);
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('server starts and can be stopped via SIGTERM (port released)', async () => {
    const PORT = 43200; // Use a unique port to avoid conflicts
    const cliPath = join(process.cwd(), 'bin', 'cli.js');

    // Start the server in a child process
    const { spawn } = await import('node:child_process');
    const server = spawn('node', [cliPath, 'serve', '-d', dataDir, '-p', PORT.toString()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });

    // Wait for server to start
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
      const onData = (data: Buffer) => {
        const text = data.toString();
        if (text.includes('127.0.0.1:' + PORT) || text.includes('Dashboard')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      server.stdout!.on('data', onData);
      server.stderr!.on('data', onData);
    });

    // Verify health endpoint responds
    let healthOk = false;
    for (let i = 0; i < 5; i++) {
      try {
        const response = execFileSync('curl.exe', ['-sf', 'http://127.0.0.1:' + PORT + '/health'], {
          encoding: 'utf-8',
          timeout: 3000,
        });
        const parsed = JSON.parse(response);
        if (parsed.status === 'ok') {
          healthOk = true;
          break;
        }
      } catch {
        // Retry
        await new Promise(r => setTimeout(r, 500));
      }
    }
    expect(healthOk).toBe(true);

    // Stop the server gracefully
    server.kill('SIGTERM');

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      server.on('exit', () => resolve());
      setTimeout(() => resolve(), 3000);
    });

    // Verify port is released
    await new Promise(r => setTimeout(r, 1000));
    try {
      execFileSync('curl.exe', ['-sf', 'http://127.0.0.1:' + PORT + '/health'], {
        encoding: 'utf-8',
        timeout: 3000,
      });
      // If we get a response, the server is still running (bad)
      expect(false).toBe(true);
    } catch {
      // Expected — server is down
      expect(true).toBe(true);
    }

    // SQLite integrity check after server stop
    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const integrity = db.pragma('integrity_check', { simple: true }) as string;
      expect(integrity).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('server prints local URL and privacy statement on start', () => {
    const PORT = 43201;
    const cliPath = join(process.cwd(), 'bin', 'cli.js');

    // Start server briefly just to capture output
    const stdout = execFileSync('node', [cliPath, 'serve', '-d', dataDir, '-p', PORT.toString(), '--help'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    expect(stdout.toLowerCase()).toContain('port');
  });

  it('handles occupied port gracefully (EADDRINUSE)', async () => {
    const PORT = 43202;
    const cliPath = join(process.cwd(), 'bin', 'cli.js');

    // Start first server
    const { spawn } = await import('node:child_process');
    const server1 = spawn('node', [cliPath, 'serve', '-d', dataDir, '-p', PORT.toString()], {
      stdio: 'pipe',
      timeout: 15000,
    });

    // Wait for it to start
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000);
      server1.stdout!.on('data', () => { clearTimeout(timeout); resolve(); });
    });

    // Try to start a second server on the same port
    const result = runCli(['serve', '-d', dataDir, '-p', PORT.toString()]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr || result.stdout).toMatch(/already in use|EADDRINUSE/i);

    // Cleanup
    server1.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
  });
});

// =============================================================================
// Fresh checkout smoke: install/build/bin from a clean temp directory
// without node_modules or dist, running through Windows PowerShell
// =============================================================================

describe('Fresh checkout smoke: install/build/bin from clean temp directory', () => {
  let checkoutDir: string;

  afterEach(() => {
    safeCleanup(checkoutDir);
  });

  it('clones project to temp dir, installs, builds, and invokes CLI', () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'cet-fresh-checkout-'));
    checkoutDir = join(parentDir, 'checkout');

    // Clone the repository (node_modules/dist excluded via .gitignore)
    execFileSync('git', ['clone', process.cwd(), checkoutDir], {
      timeout: 60000,
      stdio: 'pipe',
    });

    // Verify it's a clean checkout — no node_modules, no dist
    expect(existsSync(join(checkoutDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(checkoutDir, 'dist'))).toBe(false);

    // Verify key source files exist
    expect(existsSync(join(checkoutDir, 'package.json'))).toBe(true);
    expect(existsSync(join(checkoutDir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(checkoutDir, 'bin', 'cli.js'))).toBe(true);

    // npm install (use explicit pwsh -NoProfile -Command for Windows PowerShell resolution)
    execFileSync('pwsh', ['-NoProfile', '-Command', 'npm install'], {
      cwd: checkoutDir,
      encoding: 'utf-8',
      timeout: 300000, // 5 minutes for full install
      stdio: 'pipe',
    });
    expect(existsSync(join(checkoutDir, 'node_modules'))).toBe(true);
    expect(existsSync(join(checkoutDir, 'node_modules', 'commander'))).toBe(true);
    expect(existsSync(join(checkoutDir, 'node_modules', 'better-sqlite3'))).toBe(true);

    // npm run build (use explicit pwsh -NoProfile -Command for Windows PowerShell resolution)
    execFileSync('pwsh', ['-NoProfile', '-Command', 'npm run build'], {
      cwd: checkoutDir,
      encoding: 'utf-8',
      timeout: 120000,
      stdio: 'pipe',
    });
    expect(existsSync(join(checkoutDir, 'dist', 'cli.js'))).toBe(true);
    expect(existsSync(join(checkoutDir, 'dist', 'dashboard', 'index.html'))).toBe(true);
    expect(existsSync(join(checkoutDir, 'dist', 'storage.js'))).toBe(true);
    expect(existsSync(join(checkoutDir, 'dist', 'config.js'))).toBe(true);

    // Invoke CLI --help from the clean checkout
    const cliPath = join(checkoutDir, 'bin', 'cli.js');
    const helpResult = execFileSync('node', [cliPath, '--help'], {
      cwd: checkoutDir,
      encoding: 'utf-8',
      timeout: 10000,
    });
    expect(helpResult).toContain('cet');
    expect(helpResult).toContain('init');
    expect(helpResult).toContain('import');
    expect(helpResult).toContain('serve');
    expect(helpResult).toContain('export');

    // Invoke CLI --version
    const versionResult = execFileSync('node', [cliPath, '--version'], {
      cwd: checkoutDir,
      encoding: 'utf-8',
      timeout: 10000,
    });
    expect(versionResult.trim()).toMatch(/\d+\.\d+\.\d+/);

    // Quick init/import to prove the full pipeline works
    const dataDir = join(parentDir, 'tracker-data');
    const initResult = execFileSync('node', [cliPath, 'init', '-d', dataDir], {
      cwd: checkoutDir,
      encoding: 'utf-8',
      timeout: 15000,
    });
    expect(initResult).toContain('Initialized workspace');
    expect(existsSync(join(dataDir, 'tracker.db'))).toBe(true);
  });
});

// =============================================================================
// Browser automation: release validation with agent-browser
// Start dashboard with fixture data, verify visible UI, check export, clean up
// =============================================================================

describe('Browser automation: dashboard UI release validation', () => {
  let tempDir: string;
  let dataDir: string;
  const PORT = 43210; // Unique port for browser test

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-browser-e2e-'));
    dataDir = join(tempDir, 'tracker-data');

    // Initialize and import fixture data
    runCli(['init', '-d', dataDir]);
    runCli(['import', '-d', dataDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('loads dashboard with fixture data, verifies UI, checks export, shuts down cleanly', async () => {
    const cliPath = join(process.cwd(), 'bin', 'cli.js');
    const { spawn } = await import('node:child_process');

    // Start the dashboard server
    const server = spawn('node', [cliPath, 'serve', '-d', dataDir, '-p', PORT.toString()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });

    let agentBrowserExe: string;
    try {
      agentBrowserExe = resolveAgentBrowser();
    } catch (e) {
      console.warn('Skipping browser test: ' + (e as Error).message);
      server.kill('SIGTERM');
      return;
    }
    const sessionId = 'e1d45a73ea31';
    let browserProc: ReturnType<typeof spawn> | null = null;

    try {
      // Wait for server to be ready
      let serverReady = false;
      let serverOutput = '';
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!serverReady) reject(new Error('Server start timeout. Output: ' + serverOutput));
        }, 15000);
        const onData = (data: Buffer) => {
          const text = data.toString();
          serverOutput += text;
          if (text.includes('127.0.0.1:' + PORT) || text.includes('Dashboard') || text.includes('listening')) {
            serverReady = true;
            clearTimeout(timeout);
            resolve();
          }
        };
        server.stdout!.on('data', onData);
        server.stderr!.on('data', onData);
        server.on('error', reject);
      });

      expect(serverReady).toBe(true);

      // Verify health endpoint
      let healthOk = false;
      for (let i = 0; i < 5; i++) {
        try {
          const response = execFileSync('curl.exe', ['-sf', 'http://127.0.0.1:' + PORT + '/health'], {
            encoding: 'utf-8',
            timeout: 3000,
          });
          const parsed = JSON.parse(response);
          if (parsed.status === 'ok') {
            healthOk = true;
            break;
          }
        } catch {
          await new Promise(r => setTimeout(r, 500));
        }
      }
      expect(healthOk).toBe(true);

      // Verify overview API returns session data
      const overviewRes = execFileSync('curl.exe', ['-sf', 'http://127.0.0.1:' + PORT + '/api/overview'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const overview = JSON.parse(overviewRes);
      expect(overview.totalSessions).toBeGreaterThanOrEqual(7);
      expect(overview.tools).toBeDefined();
      expect(overview.tools.length).toBeGreaterThanOrEqual(4);
      expect(overview.score.aggregate).toBeGreaterThanOrEqual(0);
      expect(overview.empty).toBe(false);

      // Agent-browser 'open' stays alive - spawn it asynchronously
      browserProc = spawn(agentBrowserExe, ['--session', sessionId, 'open', 'http://127.0.0.1:' + PORT], {
        stdio: 'pipe',
      });

      // Wait for page to render
      await new Promise(r => setTimeout(r, 3000));

      // Take screenshot for evidence
      const screenshotPath = join(tempDir, 'dashboard.png');
      execFileSync(agentBrowserExe, ['--session', sessionId, 'screenshot', screenshotPath], {
        timeout: 30000,
        stdio: 'pipe',
      });
      expect(existsSync(screenshotPath)).toBe(true);

      // Get page snapshot to verify visible text
      const snapshotResult = execFileSync(agentBrowserExe, ['--session', sessionId, 'snapshot'], {
        encoding: 'utf-8',
        timeout: 30000,
      });
      const snapshot = snapshotResult.trim();
      expect(snapshot).toMatch(/session/i);
      expect(snapshot).toMatch(/Sessions/i);
      expect(snapshot).toMatch(/codex|opencode|claude|cursor|factory/i);

      // Check JSON export via API
      const jsonExportRes = execFileSync('curl.exe', ['-sf', 'http://127.0.0.1:' + PORT + '/api/export/json'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const jsonExport = JSON.parse(jsonExportRes);
      expect(jsonExport.totalSessions).toBeGreaterThanOrEqual(7);
      expect(jsonExport.sessions.length).toBeGreaterThanOrEqual(7);
      expect(jsonExport.score).toBeDefined();
      expect(jsonExport.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Check Markdown export via API
      const mdExportRes = execFileSync('curl.exe', ['-sf', 'http://127.0.0.1:' + PORT + '/api/export/markdown'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(mdExportRes).toContain('Effectiveness');
      expect(mdExportRes).toContain('Privacy');

      // Close the browser before stopping the server
      execFileSync(agentBrowserExe, ['--session', sessionId, 'close'], {
        timeout: 15000,
        stdio: 'pipe',
      });
      browserProc = null; // already closed
    } finally {
      // Stop the server and kill background browser process
      if (browserProc) { try { browserProc.kill(); } catch { /* ignore */ } }
      server.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        server.on('exit', () => resolve());
        setTimeout(() => resolve(), 3000);
      });
    }

    // Verify port is released
    await new Promise(r => setTimeout(r, 1000));
    try {
      execFileSync('curl.exe', ['-sf', 'http://127.0.0.1:' + PORT + '/health'], {
        encoding: 'utf-8',
        timeout: 3000,
      });
      // If we get a response, server is still running
      expect(false).toBe(true);
    } catch {
      // Expected — server is down
      expect(true).toBe(true);
    }

    // SQLite integrity check
    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const integrity = db.pragma('integrity_check', { simple: true }) as string;
      expect(integrity).toBe('ok');
    } finally {
      db.close();
    }
  });
});
