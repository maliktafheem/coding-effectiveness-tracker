import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
    const unicodePath = join(tempDir, 'proyecto-español');
    const result = runCli(['init', '-d', unicodePath]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(unicodePath, 'tracker.db'))).toBe(true);
  });
});
