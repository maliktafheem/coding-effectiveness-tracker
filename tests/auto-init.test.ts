/**
 * Tests for auto-initialization behavior of all CLI commands.
 *
 * Verifies that commands (import, report, annotate, sync, test-outcome, serve, export)
 * auto-initialize the workspace via ensureInitialized() instead of failing with
 * "Run cet init first".
 *
 * Each test creates a fresh temp directory, runs a command without prior init,
 * and confirms the workspace was silently initialized.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { runCli } from './helpers.js';
import { ensureInitialized } from '../src/config.js';

/**
 * Verify the workspace at dataDir was properly initialized:
 * - tracker.db exists
 * - Default tools are present (codex, opencode, etc.)
 */
function verifyInitialized(dataDir: string): void {
  const dbPath = join(dataDir, 'tracker.db');
  expect(existsSync(dbPath)).toBe(true);

  const db = new Database(dbPath, { readonly: true });
  try {
    const tools = db.prepare('SELECT name FROM tools ORDER BY name').all() as { name: string }[];
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('codex');
    expect(toolNames).toContain('opencode');
    expect(toolNames).toContain('factory-droid');
    expect(toolNames).toContain('claude-code');
    expect(toolNames).toContain('cursor');

    // Verify core tables exist (created by Storage.open migrations)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('events');
  } finally {
    db.close();
  }
}

describe('ensureInitialized - programmatic', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-auto-init-unit-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the database and default tools when not initialized', () => {
    ensureInitialized(tempDir);
    verifyInitialized(tempDir);
  });

  it('is idempotent - does not throw when called multiple times', () => {
    ensureInitialized(tempDir);
    ensureInitialized(tempDir);  // second call should be a no-op
    verifyInitialized(tempDir);
  });

  it('creates subdirectories (importers, exports, correlations)', () => {
    ensureInitialized(tempDir);
    expect(existsSync(join(tempDir, 'importers'))).toBe(true);
    expect(existsSync(join(tempDir, 'exports'))).toBe(true);
    expect(existsSync(join(tempDir, 'correlations'))).toBe(true);
  });
});

describe('auto-init via CLI - import command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-auto-import-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('auto-initializes and proceeds instead of failing with "Run cet init first"', () => {
    const result = runCli(['import', '--dry-run', '-d', dataDir]);
    // Should succeed (exit 0) - auto-init then print "No explicit source specified"
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Run cet init first');
    expect(result.stdout).toContain('No explicit source specified');
    verifyInitialized(dataDir);
  });
});

describe('auto-init via CLI - report command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-auto-report-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('auto-initializes and shows empty report', () => {
    const result = runCli(['report', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Run cet init first');
    expect(result.stdout).toContain('No sessions recorded');
    verifyInitialized(dataDir);
  });
});

describe('auto-init via CLI - annotate command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-auto-annotate-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('auto-initializes then validates session (not init error)', () => {
    const result = runCli(['annotate', '--session', 'test-session', '--outcome', 'good', '-d', dataDir]);
    // Should auto-init, then fail because session doesn't exist
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('Run cet init first');
    expect(output).toContain('Session not found');
    verifyInitialized(dataDir);
  });
});

describe('auto-init via CLI - sync command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-auto-sync-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('auto-initializes then validates repo (not init error)', () => {
    const result = runCli(['sync', '--repo', tempDir, '-d', dataDir]);
    // Should auto-init, then fail because tempDir is not a git repo
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('Run cet init first');
    expect(output).toContain('Not a git repository');
    verifyInitialized(dataDir);
  });
});

describe('auto-init via CLI - test-outcome command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-auto-test-outcome-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('auto-initializes and ingests test outcome', () => {
    const result = runCli(['test-outcome', '--command', 'npm test', '--passed', '10', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Run cet init first');
    expect(result.stdout).toContain('Test outcome ingest complete');
    verifyInitialized(dataDir);
  });
});

describe('auto-init via CLI - export command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-auto-export-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('auto-initializes and exports report', () => {
    const outputPath = join(tempDir, 'report.json');
    const result = runCli(['export', '--output', outputPath, '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Run cet init first');
    expect(result.stdout).toContain('Exported');
    verifyInitialized(dataDir);
  });
});

describe('auto-init via CLI - serve command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-auto-serve-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('ensureInitialized works for serve use case (programmatic)', () => {
    // The serve command blocks (starts a server), so we verify the
    // auto-init behavior programmatically - it uses the same ensureInitialized
    ensureInitialized(dataDir);
    verifyInitialized(dataDir);
  });

  it('serve auto-initializes and proceeds to server startup (not init error)', () => {
    // Use a high port to avoid conflicts; serve will auto-init then try to
    // start the server. We verify init happened before the server attempt.
    const result = runCli(['serve', '-d', dataDir, '--port', '43199']);
    // Since we use a temp dir, serve should auto-init, then try to start.
    // The CLI command blocks, so execFileSync will wait. We use a timeout of 5s
    // and expect it to have auto-initialized before the timeout.
    // The exit code varies depending on whether the port was available.
    // We just verify it didn't error about init.
    expect(result.stdout + result.stderr).not.toContain('Run cet init first');
    // DB should have been created before the server attempted to start
    verifyInitialized(dataDir);
  });
});

describe('init command remains unchanged', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-auto-init-check-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('explicit init still prints setup messages', () => {
    const result = runCli(['init', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized workspace');
    expect(result.stdout).toContain('Database:');
  });

  it('auto-init and explicit init are compatible', () => {
    // Run a command that auto-inits
    runCli(['import', '--dry-run', '-d', dataDir]);
    // Then run explicit init - should say "Already initialized"
    const result = runCli(['init', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Already initialized');
  });
});
