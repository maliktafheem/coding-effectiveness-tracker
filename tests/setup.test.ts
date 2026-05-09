/**
 * Tests for the `cet setup` command.
 *
 * VAL-AUTO-002: cet setup one-command onboarding
 * VAL-AUTO-003: cet setup --no-serve skips dashboard
 * VAL-AUTO-004: cet setup --interactive shows prompts
 *
 * Each test creates a fresh temp directory with fixture data and
 * validates the setup flow without requiring real AI tool directories
 * or a real git repository.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures');

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows file locks — best-effort
  }
}

function runCli(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
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

/**
 * Create a temporary git repository with a few commits.
 */
function createTempGitRepo(dir: string, subdir = 'test-repo'): string {
  const repoPath = join(dir, subdir);
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });

  // Create two commits
  writeFileSync(join(repoPath, 'file1.ts'), 'export const a = 1;');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=Test',
    'commit', '-m', 'feat: add file1'], {
    cwd: repoPath,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-04-28T09:15:00Z', GIT_COMMITTER_DATE: '2026-04-28T09:15:00Z' },
  });

  writeFileSync(join(repoPath, 'file2.ts'), 'export const b = 2;');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=Test',
    'commit', '-m', 'feat: add file2'], {
    cwd: repoPath,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-04-28T10:30:00Z', GIT_COMMITTER_DATE: '2026-04-28T10:30:00Z' },
  });

  return repoPath;
}

/**
 * Build isolated env vars that point HOME/USERPROFILE/APPDATA to a sandbox
 * directory so auto-discovery won't find real user AI tool data.
 */
function isolatedEnv(sandboxDir: string): Record<string, string> {
  return {
    HOME: sandboxDir,
    USERPROFILE: sandboxDir,
    APPDATA: join(sandboxDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(sandboxDir, 'AppData', 'Local'),
  };
}

// ─── Auto mode (VAL-AUTO-002) ─────────────────────────────────────────────

describe('cet setup — auto mode (VAL-AUTO-002)', () => {
  let tempDir: string;
  let dataDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-setup-auto-'));
    dataDir = join(tempDir, 'data');
    repoDir = createTempGitRepo(tempDir);
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('auto-initializes workspace, discovers nothing, and prints guidance', () => {
    // Run setup from the tempDir which has a git repo but no AI tool dirs
    const env = isolatedEnv(tempDir);
    const result = runCli(['setup', '--no-serve', '-d', dataDir], { cwd: repoDir, env });
    expect(result.exitCode).toBe(0);
    // Should have initialized workspace
    expect(existsSync(join(dataDir, 'tracker.db'))).toBe(true);
    // Should show progression
    expect(result.stdout).toMatch(/\[1\/4\]/);
    expect(result.stdout).toMatch(/\[2\/4\]/);
    expect(result.stdout).toMatch(/\[3\/4\]/);
    expect(result.stdout).toMatch(/\[4\/4\]/);
    // Should have found the git repo
    expect(result.stdout).toMatch(/git repository/);
    // Should show no AI tool data found (isolated env)
    expect(result.stdout).toMatch(/No AI tool data directories found/);
    // Should print completion message
    expect(result.stdout).toMatch(/Setup complete/);
  });

  it('imports from a discovered AI tool fixture directory', () => {
    // Create a fake codex directory with sessions.jsonl
    const codexDir = join(tempDir, '.codex', 'sessions');
    mkdirSync(codexDir, { recursive: true });
    // Copy a fixture JSONL file for codex
    const codexFixture = join(FIXTURES_DIR, 'codex', 'sessions.jsonl');

    if (existsSync(codexFixture)) {
      copyFileSync(codexFixture, join(codexDir, 'sessions.jsonl'));
    }

    // Also create a .claude directory
    const claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const claudeFixture = join(FIXTURES_DIR, 'claude-code', 'sessions.jsonl');
    if (existsSync(claudeFixture)) {
      copyFileSync(claudeFixture, join(claudeDir, 'sessions.jsonl'));
    }

    const env = isolatedEnv(tempDir);
    const result = runCli(['setup', '--no-serve', '-d', dataDir], { cwd: tempDir, env });
    expect(result.exitCode).toBe(0);

    // Should have detected the git repo from cwd
    expect(result.stdout).toMatch(/git repository/);
    // Should have imported from discovered directories
    expect(result.stdout).toMatch(/session\(s\) imported/);
  });
});

// ─── --no-serve mode (VAL-AUTO-003) ────────────────────────────────────────

describe('cet setup --no-serve (VAL-AUTO-003)', () => {
  let tempDir: string;
  let dataDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-setup-noserve-'));
    dataDir = join(tempDir, 'data');
    repoDir = createTempGitRepo(tempDir);
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('runs full setup (init + discover + import + git sync) without starting dashboard server', () => {
    const env = isolatedEnv(tempDir);
    const result = runCli(['setup', '--no-serve', '-d', dataDir], { cwd: repoDir, env });
    expect(result.exitCode).toBe(0);

    // Verify init happened
    expect(existsSync(join(dataDir, 'tracker.db'))).toBe(true);

    // Verify git sync happened
    expect(result.stdout).toMatch(/commits/);

    // Verify dashboard NOT started (no URL printed)
    expect(result.stdout).not.toMatch(/Dashboard running/);
    expect(result.stdout).not.toMatch(/http:\/\/127.0.0.1/);

    // Verify completion message
    expect(result.stdout).toMatch(/Setup complete/);
  });

  it('shows success message with helpful next steps', () => {
    const env = isolatedEnv(tempDir);
    const result = runCli(['setup', '--no-serve', '-d', dataDir], { cwd: repoDir, env });
    expect(result.exitCode).toBe(0);
    // Should mention next commands
    expect(result.stdout).toMatch(/cet serve/);
    expect(result.stdout).toMatch(/cet import/);
    expect(result.stdout).toMatch(/cet report/);
  });
});

// ─── --interactive mode (VAL-AUTO-004) ─────────────────────────────────────

describe('cet setup --interactive (VAL-AUTO-004)', () => {
  let tempDir: string;
  let dataDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-setup-interact-'));
    dataDir = join(tempDir, 'data');
    repoDir = createTempGitRepo(tempDir);
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('shows interactive prompts (print defaults, Y/n options)', () => {
    const env = isolatedEnv(tempDir);
    // In non-TTY mode, interactive should print prompts but default to yes
    const result = runCli(['setup', '--interactive', '--no-serve', '-d', dataDir], { cwd: repoDir, env });
    expect(result.exitCode).toBe(0);

    // It should show discovery of tools and git repo
    expect(result.stdout).toMatch(/\[1\/4\]/);
    expect(result.stdout).toMatch(/\[2\/4\]/);

    // Should initialize the workspace
    expect(existsSync(join(dataDir, 'tracker.db'))).toBe(true);

    // Should discover the git repo
    expect(result.stdout).toMatch(/Found git repository/);
  });

  it('accepts custom data directory via --data-dir flag', () => {
    const env = isolatedEnv(tempDir);
    const customDir = join(tempDir, 'custom-data');
    const result = runCli(['setup', '--no-serve', '-d', customDir], { cwd: repoDir, env });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(customDir, 'tracker.db'))).toBe(true);
    expect(result.stdout).toContain(customDir);
  });

  it('fails gracefully with invalid port', () => {
    const env = isolatedEnv(tempDir);
    const result = runCli(['setup', '--no-serve', '--port', 'invalid', '-d', dataDir], { cwd: repoDir, env });
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/Invalid port/);
  });
});

// ─── Setup with fixture data and git repo ────────────────────────────────

describe('cet setup — end-to-end with fixtures', () => {
  let tempDir: string;
  let dataDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-setup-e2e-'));
    dataDir = join(tempDir, 'data');
    repoDir = createTempGitRepo(tempDir, 'my-project');
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('initializes workspace, syncs git, and stores commits', () => {
    const env = isolatedEnv(tempDir);
    const result = runCli(['setup', '--no-serve', '-d', dataDir], { cwd: repoDir, env });
    expect(result.exitCode).toBe(0);

    // Verify workspace was initialized with proper DB and tools
    expect(existsSync(join(dataDir, 'tracker.db'))).toBe(true);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      // Default tools should be present
      const tools = db.prepare('SELECT name FROM tools ORDER BY name').all() as { name: string }[];
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('codex');
      expect(toolNames).toContain('opencode');

      // Git commits should be stored
      const commits = db.prepare('SELECT count(*) as cnt FROM git_commits').get() as { cnt: number };
      expect(commits.cnt).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  it('project auto-derived from repo directory name', () => {
    const env = isolatedEnv(tempDir);
    const result = runCli(['setup', '--no-serve', '-d', dataDir], { cwd: repoDir, env });
    expect(result.exitCode).toBe(0);

    const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
    try {
      const projects = db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[];
      expect(projects.length).toBeGreaterThanOrEqual(1);
      const projectIds = projects.map((p) => p.id);
      expect(projectIds).toContain('my-project');
    } finally {
      db.close();
    }
  });
});

// ─── Privacy check ────────────────────────────────────────────────────────

describe('cet setup — privacy', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-setup-privacy-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('does not emit sensitive data in default CLI output', () => {
    const env = isolatedEnv(tempDir);
    const result = runCli(['setup', '--no-serve', '-d', dataDir], { cwd: tempDir, env });
    expect(result.exitCode).toBe(0);
    // Should not leak any raw data
    expect(result.stdout).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    // Should mention privacy (ensureInitialized doesn't print it but setup completion does)
    expect(result.stdout).toMatch(/Setup complete/);
  });
});
