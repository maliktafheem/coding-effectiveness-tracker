/**
 * Shared test helpers extracted from existing test files.
 *
 * Provides safeCleanup, runCli, and createTestStorage for use across
 * all test files, reducing duplication and ensuring consistent behavior.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureDataDir } from '../src/config.js';
import { Storage } from '../src/storage.js';

/**
 * Safely remove a directory tree, retrying on Windows file locks.
 */
export function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows may hold file locks briefly; best-effort cleanup
  }
}

/**
 * Run the CLI via `node bin/cli.js` with the given arguments.
 * Returns stdout, stderr, and exit code.
 */
export function runCli(
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
 * Create temporary Storage with default tools and projects pre-seeded.
 * Useful for tests that need a working database with known fixtures.
 */
export function createTestStorage(tempDir: string): Storage {
  const dataDir = ensureDataDir(join(tempDir, 'data'));
  const storage = Storage.open({ dataDir });
  const db = storage.db;
  const defaultTools = [
    { id: 'codex', name: 'codex', display_name: 'Codex' },
    { id: 'opencode', name: 'opencode', display_name: 'OpenCode' },
    { id: 'factory-droid', name: 'factory-droid', display_name: 'Factory Droid' },
    { id: 'claude-code', name: 'claude-code', display_name: 'Claude Code' },
    { id: 'cursor', name: 'cursor', display_name: 'Cursor' },
    { id: 'fixture', name: 'fixture', display_name: 'Fixture Import' },
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)');
  const insertProj = db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)');
  const seedAll = db.transaction(() => {
    for (const t of defaultTools) insert.run(t.id, t.name, t.display_name);
    insertProj.run('project-alpha', 'Project Alpha');
    insertProj.run('project-beta', 'Project Beta');
  });
  seedAll();
  return storage;
}
