import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

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
      timeout: 15000,
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

describe('CLI init command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-init-test-'));
    dataDir = join(tempDir, 'tracker-data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // VAL-CLI-004: Initialize creates local workspace
  it('creates local configuration and SQLite database', () => {
    const result = runCli(['init', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized workspace');
    expect(result.stdout).toContain(dataDir);

    // Check database exists
    const dbPath = join(dataDir, 'tracker.db');
    expect(existsSync(dbPath)).toBe(true);

    // Check subdirectories exist
    expect(existsSync(join(dataDir, 'importers'))).toBe(true);
    expect(existsSync(join(dataDir, 'exports'))).toBe(true);
    expect(existsSync(join(dataDir, 'correlations'))).toBe(true);

    // Verify database contains default tools
    const db = new Database(dbPath, { readonly: true });
    try {
      const tools = db.prepare('SELECT name FROM tools ORDER BY name').all() as { name: string }[];
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('codex');
      expect(toolNames).toContain('opencode');
      expect(toolNames).toContain('factory-droid');
      expect(toolNames).toContain('claude-code');
      expect(toolNames).toContain('cursor');

      // Verify core tables exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('events');
      expect(tableNames).toContain('git_commits');
      expect(tableNames).toContain('test_outcomes');
      expect(tableNames).toContain('outcomes');
      expect(tableNames).toContain('correlations');
    } finally {
      db.close();
    }

    // Verify privacy message
    expect(result.stdout.toLowerCase()).toContain('privacy');
  });

  // VAL-CLI-005: Initialize is idempotent
  it('succeeds on second run and preserves existing data', () => {
    // First init
    const result1 = runCli(['init', '-d', dataDir]);
    expect(result1.exitCode).toBe(0);

    // Insert custom data
    const dbPath = join(dataDir, 'tracker.db');
    const db = new Database(dbPath);
    db.exec(`INSERT INTO projects (id, name) VALUES ('custom-project', 'My Project');`);
    db.close();

    // Second init (without --force)
    const result2 = runCli(['init', '-d', dataDir]);
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).toContain('Already initialized');

    // Verify custom data preserved
    const db2 = new Database(dbPath, { readonly: true });
    try {
      const projects = db2.prepare('SELECT * FROM projects WHERE id = ?').get('custom-project');
      expect(projects).toBeTruthy();
    } finally {
      db2.close();
    }
  });

  // VAL-CLI-006: Initialize refuses unsafe overwrite
  it('warns on re-init without --force', () => {
    // First init
    runCli(['init', '-d', dataDir]);

    // Second init without --force should not overwrite
    const result = runCli(['init', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Already initialized');
    expect(result.stdout).toContain('--force');
  });

  it('allows reinit with --force', () => {
    // First init
    runCli(['init', '-d', dataDir]);

    // Init with force
    const result = runCli(['init', '-d', dataDir, '--force']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Reinitializing');
  });

  // VAL-CLI-007: Custom data directory is honored
  it('honors custom data directory via -d flag', () => {
    const customDir = join(tempDir, 'custom path (special)');
    const result = runCli(['init', '-d', customDir]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(customDir, 'tracker.db'))).toBe(true);
    expect(result.stdout).toContain(customDir);
  });

  it('honors CET_DATA_DIR environment variable', () => {
    const envDir = join(tempDir, 'env-data-dir');
    const result = runCli(['init'], { env: { CET_DATA_DIR: envDir } });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(envDir, 'tracker.db'))).toBe(true);
    expect(result.stdout).toContain(envDir);
  });

  // VAL-WIN-001: Windows paths with spaces, parens, unicode
  it('handles Windows-style paths with spaces', () => {
    const spacedPath = join(tempDir, 'My Projects', 'effectiveness tracker');
    const result = runCli(['init', '-d', spacedPath]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(spacedPath, 'tracker.db'))).toBe(true);
  });

  it('handles paths with parentheses', () => {
    const parensPath = join(tempDir, 'Project (2)');
    const result = runCli(['init', '-d', parensPath]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(parensPath, 'tracker.db'))).toBe(true);
  });

  it('handles paths with unicode characters', () => {
    const unicodePath = join(tempDir, 'proyecto-espanol');
    const result = runCli(['init', '-d', unicodePath]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(unicodePath, 'tracker.db'))).toBe(true);
  });

  // VAL-CLI-006 / VAL-CLI-040: non-force init against corrupt DB exits non-zero with recovery guidance
  it('refuses re-init on existing corrupt DB without --force', () => {
    const corruptDir = join(tempDir, 'corrupt-data');
    runCli(['init', '-d', corruptDir]);

    // Replace with corrupt content
    const corruptPath = join(corruptDir, 'tracker.db');
    writeFileSync(corruptPath, 'this is not a valid sqlite database');

    // Capture bytes before running non-force init
    const bytesBefore = readFileSync(corruptPath);

    const result = runCli(['init', '-d', corruptDir]);
    // Must exit non-zero
    expect(result.exitCode).not.toBe(0);

    // Must include recovery guidance
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('--force');
    expect(combined.toLowerCase()).toMatch(/corrupt|incompatible|integrity/);

    // No stack trace leaks
    expect(combined).not.toContain('at Object.');
    expect(combined).not.toContain('node_modules');
    expect(combined).not.toContain('StorageError');

    // Corrupt file must be preserved byte-for-byte
    expect(existsSync(corruptPath)).toBe(true);
    const bytesAfter = readFileSync(corruptPath);
    expect(Buffer.compare(bytesBefore, bytesAfter)).toBe(0);
  });

  // Corruption recovery with --force: non-SQLite tracker.db
  it('recovers from corrupt non-SQLite tracker.db with --force', () => {
    const corruptDir = join(tempDir, 'corrupt-force');
    runCli(['init', '-d', corruptDir]);
    writeFileSync(join(corruptDir, 'tracker.db'), 'this is not a valid sqlite database');
    expect(existsSync(join(corruptDir, 'tracker.db'))).toBe(true);

    const result = runCli(['init', '-d', corruptDir, '--force']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Moved corrupt database');
    expect(result.stdout).toContain('Initialized workspace');

    const dbPath = join(corruptDir, 'tracker.db');
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    try {
      const check = db.pragma('integrity_check', { simple: true }) as string;
      expect(check).toBe('ok');
      const tools = db.prepare('SELECT name FROM tools').all() as { name: string }[];
      expect(tools.length).toBeGreaterThanOrEqual(5);
    } finally {
      db.close();
    }

    const backupFiles = readdirSync(corruptDir).filter((f) => f.startsWith('tracker.db.corrupt.'));
    expect(backupFiles.length).toBe(1);
  });

  // Zero-byte tracker.db opens as valid empty SQLite, so --force reinitializes without moving
  it('handles zero-byte tracker.db with --force without error', () => {
    const corruptDir = join(tempDir, 'corrupt-zero');
    runCli(['init', '-d', corruptDir]);
    writeFileSync(join(corruptDir, 'tracker.db'), '');

    const result = runCli(['init', '-d', corruptDir, '--force']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized workspace');

    const dbPath = join(corruptDir, 'tracker.db');
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    try {
      const check = db.pragma('integrity_check', { simple: true }) as string;
      expect(check).toBe('ok');
    } finally {
      db.close();
    }
  });

  // Privacy evidence: default CLI output does not emit raw secrets
  it('does not emit sensitive data in default CLI output', () => {
    const result = runCli(['init', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toMatch(/password/i);
    expect(combined).not.toMatch(/secret/i);
    expect(combined).not.toMatch(/token/i);
    expect(combined).not.toMatch(/api[_-]?key/i);
    expect(result.stdout.toLowerCase()).toContain('privacy');
    expect(result.stdout.toLowerCase()).toContain('local');
  });
});