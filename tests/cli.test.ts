import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * CLI integration tests for VAL-CLI-001, VAL-CLI-002, VAL-CLI-003.
 * These test the CLI through the actual built entrypoint.
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
      timeout: 10000,
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

describe('CLI basics', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-cli-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // VAL-CLI-001: CLI help is discoverable
  it('shows help with --help and lists primary commands', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('import');
    expect(result.stdout).toContain('report');
    expect(result.stdout).toContain('serve');
    expect(result.stdout).toContain('--help');
    expect(result.stdout).toContain('--version');
    // Verify privacy/local-first wording
    expect(result.stdout.toLowerCase()).toMatch(/local|privacy|no telemetry/);
  });

  // VAL-CLI-002: Unknown command fails clearly
  it('fails with a clear message on unknown command', () => {
    const result = runCli(['bogus-command']);
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined.toLowerCase()).toContain('unknown command');
    expect(combined).toContain('bogus-command');
    expect(combined).toContain('--help');
    // No stack trace
    expect(combined).not.toContain('at Object.');
    expect(combined).not.toContain('node_modules');
  });

  // VAL-CLI-003: Version output is non-mutating
  it('shows version with --version and does not create files', () => {
    const versionDir = join(tempDir, 'version-test');
    const result = runCli(['--version'], { env: { CET_DATA_DIR: versionDir } });
    expect(result.exitCode).toBe(0);
    // Output should contain a semver-like string
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    // No files should be created
    expect(existsSync(versionDir)).toBe(false);
  });

  it('shows version with -v shorthand', () => {
    const result = runCli(['-v']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });
});
