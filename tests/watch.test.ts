/**
 * Tests for the `cet watch` command.
 *
 * Tests the daemon lifecycle: start, stop, status, stale PID handling.
 * All tests use temporary data directories to avoid interfering with
 * the user's real tracker data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const CLI_PATH = join(process.cwd(), 'bin', 'cli.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[], opts?: { env?: Record<string, string>; timeout?: number }): CliResult {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, ...opts?.env },
      timeout: opts?.timeout ?? 15000,
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

function safeCleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows file locks */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('cet watch — CLI integration', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-watch-test-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    // Stop any running daemon before cleanup
    runCli(['watch', '--stop', '-d', dataDir], { timeout: 5000 });
    safeCleanup(tempDir);
  });

  // VAL-WATCH-001: cet watch --help shows the command
  it('shows watch command in help output', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('watch');
    expect(result.stdout).toContain('daemon');
  });

  // VAL-WATCH-002: Start daemon, verify PID file created
  it('starts daemon and creates PID file', async () => {
    const result = runCli(['watch', '-d', dataDir, '--interval', '10']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Watch daemon started/i);
    expect(result.stdout).toMatch(/PID:/);

    // Verify PID file exists (written by parent before exit)
    const pidPath = join(dataDir, 'watch.pid');
    expect(existsSync(pidPath)).toBe(true);

    // Verify PID file contains a valid number
    const pidContent = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(pidContent, 10);
    expect(isNaN(pid)).toBe(false);
    expect(pid).toBeGreaterThan(0);

    // Give the daemon a moment to start and log
    await sleep(500);
  });

  // VAL-WATCH-003: cet watch --status shows running state
  it('shows daemon running with --status', async () => {
    // Start daemon
    const startResult = runCli(['watch', '-d', dataDir, '--interval', '10']);
    expect(startResult.exitCode).toBe(0);
    await sleep(500);

    // Check status
    const statusResult = runCli(['watch', '--status', '-d', dataDir]);
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toMatch(/Daemon running/i);
    expect(statusResult.stdout).toMatch(/PID:/);
    expect(statusResult.stdout).toMatch(/watch\.log/);
  });

  // VAL-WATCH-004: cet watch --stop stops daemon and cleans PID file
  it('stops daemon and cleans up PID file', async () => {
    // Start daemon
    const startResult = runCli(['watch', '-d', dataDir, '--interval', '10']);
    expect(startResult.exitCode).toBe(0);
    await sleep(500);

    const pidPath = join(dataDir, 'watch.pid');
    expect(existsSync(pidPath)).toBe(true);

    // Stop daemon
    const stopResult = runCli(['watch', '--stop', '-d', dataDir], { timeout: 10000 });
    expect(stopResult.exitCode).toBe(0);
    expect(stopResult.stdout).toMatch(/Watch daemon stopped/i);

    // PID file should be removed
    expect(existsSync(pidPath)).toBe(false);
  });

  // VAL-WATCH-005: cet watch --status shows not running after stop
  it('shows daemon not running after stop', async () => {
    runCli(['watch', '-d', dataDir, '--interval', '10']);
    await sleep(500);
    runCli(['watch', '--stop', '-d', dataDir], { timeout: 10000 });
    await sleep(500);

    const statusResult = runCli(['watch', '--status', '-d', dataDir]);
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toMatch(/Daemon not running/i);
  });

  // VAL-WATCH-006: cet watch --stop with no daemon shows "not running"
  it('shows daemon not running when no daemon to stop', () => {
    const result = runCli(['watch', '--stop', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Daemon not running/i);
  });

  // VAL-WATCH-007: cet watch --status with no daemon shows not running
  it('shows daemon not running when never started', () => {
    const result = runCli(['watch', '--status', '-d', dataDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Daemon not running/i);
  });

  // VAL-WATCH-008: Stale PID file is cleaned up gracefully
  it('handles stale PID file gracefully', () => {
    // Ensure data directory exists
    mkdirSync(dataDir, { recursive: true });

    // Write a fake PID (a large number that's unlikely to be a real process)
    const pidPath = join(dataDir, 'watch.pid');
    writeFileSync(pidPath, '999999999', 'utf-8');

    // --status should detect stale PID
    const statusResult = runCli(['watch', '--status', '-d', dataDir]);
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toMatch(/stale PID cleaned/i);

    // PID file should be cleaned up
    expect(existsSync(pidPath)).toBe(false);

    // --stop should also handle stale PID
    writeFileSync(pidPath, '999999999', 'utf-8');
    const stopResult = runCli(['watch', '--stop', '-d', dataDir]);
    expect(stopResult.exitCode).toBe(0);
    expect(stopResult.stdout).toMatch(/cleaned up stale PID/i);
    expect(existsSync(pidPath)).toBe(false);
  });

  // VAL-WATCH-009: Daemon auto-initializes workspace
  it('auto-initializes workspace when starting daemon', () => {
    // Start daemon without prior init
    const result = runCli(['watch', '-d', dataDir, '--interval', '10']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Watch daemon started/i);

    // Verify workspace was initialized
    const dbPath = join(dataDir, 'tracker.db');
    expect(existsSync(dbPath)).toBe(true);

    // Verify default tools exist
    const db = new Database(dbPath, { readonly: true });
    try {
      const tools = db.prepare('SELECT name FROM tools ORDER BY name').all() as { name: string }[];
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('codex');
      expect(toolNames).toContain('opencode');
    } finally {
      db.close();
    }
  });

  // VAL-WATCH-010: Daemon logs activity
  it('logs activity to watch.log', async () => {
    const result = runCli(['watch', '-d', dataDir, '--interval', '1']);
    expect(result.exitCode).toBe(0);

    // Wait for first cycle
    await sleep(2000);

    const logPath = join(dataDir, 'watch.log');
    expect(existsSync(logPath)).toBe(true);

    const logContent = readFileSync(logPath, 'utf-8');
    expect(logContent).toContain('Watch daemon started');
    expect(logContent).toContain('Data directory');
    expect(logContent).toMatch(/Poll interval/);
  });

  // VAL-WATCH-011: Daemon can run with custom --interval
  it('accepts custom --interval flag', () => {
    const result = runCli(['watch', '-d', dataDir, '--interval', '5']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/5 minute\(s\)/);
  });

  // VAL-WATCH-012: Rejects invalid --interval
  it('rejects invalid --interval value', () => {
    const result = runCli(['watch', '-d', dataDir, '--interval', '0']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/positive number|minimum 1/i);
  });

  // VAL-WATCH-013: Start is idempotent - second start shows already running
  it('shows already running message when starting twice', async () => {
    runCli(['watch', '-d', dataDir, '--interval', '10']);
    await sleep(500);

    const secondStart = runCli(['watch', '-d', dataDir, '--interval', '10']);
    expect(secondStart.exitCode).toBe(0);
    expect(secondStart.stdout).toMatch(/already running/i);
  });

  // VAL-WATCH-014: Daemon creates subdirectories (importers, exports, correlations)
  it('creates data directory subdirectories when starting', () => {
    runCli(['watch', '-d', dataDir, '--interval', '10']);
    expect(existsSync(join(dataDir, 'importers'))).toBe(true);
    expect(existsSync(join(dataDir, 'exports'))).toBe(true);
    expect(existsSync(join(dataDir, 'correlations'))).toBe(true);
  });
});

describe('cet watch — lifecycle orchestration', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-watch-lifecycle-'));
    dataDir = join(tempDir, 'data');
  });

  afterEach(() => {
    runCli(['watch', '--stop', '-d', dataDir], { timeout: 5000 });
    safeCleanup(tempDir);
  });

  it('full start → status → stop → status lifecycle', async () => {
    // 1. Start
    const startResult = runCli(['watch', '-d', dataDir, '--interval', '10']);
    expect(startResult.exitCode).toBe(0);
    expect(startResult.stdout).toMatch(/Watch daemon started/i);
    const pidPath = join(dataDir, 'watch.pid');
    expect(existsSync(pidPath)).toBe(true);
    await sleep(500);

    // 2. Status - running
    const statusRunning = runCli(['watch', '--status', '-d', dataDir]);
    expect(statusRunning.exitCode).toBe(0);
    expect(statusRunning.stdout).toMatch(/Daemon running/i);

    // 3. Stop
    const stopResult = runCli(['watch', '--stop', '-d', dataDir], { timeout: 10000 });
    expect(stopResult.exitCode).toBe(0);
    expect(stopResult.stdout).toMatch(/Watch daemon stopped/i);
    expect(existsSync(pidPath)).toBe(false);

    // 4. Status - not running
    const statusStopped = runCli(['watch', '--status', '-d', dataDir]);
    expect(statusStopped.exitCode).toBe(0);
    expect(statusStopped.stdout).toMatch(/Daemon not running/i);
  });
});

describe('cet watch — data directory independence', () => {
  let tempDir1: string;
  let tempDir2: string;

  beforeEach(() => {
    tempDir1 = mkdtempSync(join(tmpdir(), 'cet-watch-indep1-'));
    tempDir2 = mkdtempSync(join(tmpdir(), 'cet-watch-indep2-'));
  });

  afterEach(() => {
    runCli(['watch', '--stop', '-d', join(tempDir1, 'data')], { timeout: 5000 });
    runCli(['watch', '--stop', '-d', join(tempDir2, 'data')], { timeout: 5000 });
    safeCleanup(tempDir1);
    safeCleanup(tempDir2);
  });

  it('multiple data directories have independent daemon state', async () => {
    const dataDir1 = join(tempDir1, 'data');
    const dataDir2 = join(tempDir2, 'data');

    // Start daemon in first data dir
    runCli(['watch', '-d', dataDir1, '--interval', '10']);
    await sleep(500);

    // First data dir should show running
    const status1 = runCli(['watch', '--status', '-d', dataDir1]);
    expect(status1.stdout).toMatch(/Daemon running/);

    // Second data dir should show not running
    const status2 = runCli(['watch', '--status', '-d', dataDir2]);
    expect(status2.stdout).toMatch(/Daemon not running/);

    // Start daemon in second data dir
    runCli(['watch', '-d', dataDir2, '--interval', '10']);
    await sleep(500);

    // Both should now show running
    const status1b = runCli(['watch', '--status', '-d', dataDir1]);
    expect(status1b.stdout).toMatch(/Daemon running/);
    const status2b = runCli(['watch', '--status', '-d', dataDir2]);
    expect(status2b.stdout).toMatch(/Daemon running/);
  });
});
