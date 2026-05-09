/**
 * Watch daemon worker process.
 *
 * This module is spawned as a child process by the `cet watch` command.
 * It runs a polling loop that:
 * 1. Ensures the workspace is initialized
 * 2. Discovers and imports new AI sessions from default tool paths
 * 3. Syncs git commits from tracked projects
 * 4. Logs activity to <dataDir>/watch.log
 *
 * Graceful shutdown on SIGTERM/SIGINT.
 */

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage } from '../storage.js';
import { collectGitSignals, storeGitSignals } from '../collectors/git.js';
import { discoverImporters, importAll } from '../importers/registry.js';

interface WatchWorkerOptions {
  dataDir: string;
  intervalMs: number;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function logMessage(logPath: string, msg: string): void {
  const line = `[${formatTimestamp()}] ${msg}\n`;
  try {
    appendFileSync(logPath, line, 'utf-8');
  } catch (err) {
    // If logging fails (e.g., data dir deleted), write to stderr as fallback
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[watch-worker] Failed to write log: ${errMsg}`);
  }
}

function logAndPrint(logPath: string, msg: string): void {
  logMessage(logPath, msg);
  console.log(msg);
}

function parseArgs(): WatchWorkerOptions {
  const args = process.argv.slice(2);
  const opts: WatchWorkerOptions = {
    dataDir: '',
    intervalMs: 10 * 60 * 1000, // default 10 minutes
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && i + 1 < args.length) {
      opts.dataDir = args[++i];
    } else if (args[i] === '--interval' && i + 1 < args.length) {
      const minutes = parseInt(args[++i], 10);
      if (!isNaN(minutes) && minutes >= 1) {
        opts.intervalMs = minutes * 60 * 1000;
      }
    }
  }

  if (!opts.dataDir) {
    opts.dataDir = resolveDataDir();
  }

  return opts;
}

/**
 * Get default AI tool source paths for discovery.
 * Mirrors the function in commands/import.ts.
 */
function getDefaultSourcePaths(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const isWin32 = process.platform === 'win32';

  if (isWin32) {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return [
      // Claude Code
      join(home, '.claude'),
      join(home, '.claude', 'projects'),
      // Codex
      join(home, '.codex'),
      join(home, '.codex', 'sessions'),
      // OpenCode
      join(appData, 'opencode'),
      // Factory Droid
      join(home, '.factory'),
      join(home, '.factory', 'sessions'),
      // Cursor
      join(appData, 'Cursor'),
      join(home, '.cursor'),
    ];
  }

  // Linux/macOS: use XDG base directory specification
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const xdgDataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share');

  return [
    // Claude Code
    join(home, '.claude'),
    join(home, '.claude', 'projects'),
    // Codex
    join(home, '.codex'),
    join(home, '.codex', 'sessions'),
    // OpenCode
    join(xdgConfigHome, 'opencode'),
    join(xdgDataHome, 'opencode'),
    // Factory Droid
    join(home, '.factory'),
    join(home, '.factory', 'sessions'),
    // Cursor
    join(xdgConfigHome, 'Cursor'),
    join(home, '.cursor'),
  ];
}

/**
 * Import sessions from discovered AI tool paths.
 */
async function runImportCycle(logPath: string, dataDir: string): Promise<void> {
  try {
    const defaultPaths = getDefaultSourcePaths();
    const existingPaths = defaultPaths.filter((p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });

    if (existingPaths.length === 0) {
      logMessage(logPath, 'No AI tool data directories found for import');
      return;
    }

    const discovered = discoverImporters(existingPaths);
    if (discovered.length === 0) {
      logMessage(logPath, 'No importable data found in AI tool directories');
      return;
    }

    let storage: Storage | undefined;
    try {
      storage = Storage.open({ dataDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logMessage(logPath, `Failed to open storage for import: ${msg}`);
      return;
    }

    try {
      const results = importAll(existingPaths, {}, storage);
      const totalImported = results.reduce((sum, r) => sum + r.imported, 0);
      const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
      if (totalImported > 0) {
        logMessage(logPath, `Imported ${totalImported} new session(s) from ${discovered.length} tool(s)`);
      }
      if (totalErrors > 0) {
        logMessage(logPath, `${totalErrors} import error(s) in this cycle`);
      }
      if (totalImported === 0 && totalErrors === 0) {
        logMessage(logPath, 'No new sessions to import');
      }
    } finally {
      try { storage.close(); } catch { /* ignore */ }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logMessage(logPath, `Import cycle error: ${msg}`);
  }
}

/**
 * Sync git commits from projects in the database.
 * Reads project paths from the projects table, then discovers repos.
 */
async function runGitSyncCycle(logPath: string, dataDir: string): Promise<void> {
  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logMessage(logPath, `Failed to open storage for git sync: ${msg}`);
    return;
  }

  try {
    const db = storage.db;
    const projects = db.prepare(
      'SELECT id, name, path FROM projects WHERE path IS NOT NULL AND path != ?',
    ).all('') as { id: string; name: string; path: string }[];

    if (projects.length === 0) {
      logMessage(logPath, 'No tracked project paths found for git sync');
      return;
    }

    let totalCommits = 0;
    let totalStored = 0;
    let syncedCount = 0;

    for (const project of projects) {
      try {
        const gitDir = join(project.path, '.git');

        if (!existsSync(project.path) || !existsSync(gitDir)) {
          logMessage(logPath, `Project "${project.name}" path no longer valid or not a git repo: ${project.path}`);
          continue;
        }

        const commits = collectGitSignals(project.path);
        if (commits.length === 0) continue;

        const stored = storeGitSignals(storage, commits, project.id);
        totalCommits += commits.length;
        totalStored += stored;
        syncedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logMessage(logPath, `Error syncing project "${project.name}": ${msg}`);
      }
    }

    if (syncedCount > 0) {
      logMessage(logPath, `Git sync: ${syncedCount} project(s), ${totalCommits} commit(s) found, ${totalStored} new commit(s) stored`);
    } else {
      logMessage(logPath, 'Git sync: no projects synced');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logMessage(logPath, `Git sync cycle error: ${msg}`);
  } finally {
    try { storage.close(); } catch { /* ignore */ }
  }
}

/**
 * Run one full poll cycle: auto-init check, import, git sync.
 */
async function runCycle(logPath: string, dataDir: string): Promise<void> {
  const cycleStart = Date.now();

  try {
    // 1. Auto-init check
    try {
      ensureInitialized(dataDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logMessage(logPath, `Auto-init check failed: ${msg}`);
      return;
    }

    // 2. Discover and import new AI sessions
    await runImportCycle(logPath, dataDir);

    // 3. Sync git commits
    await runGitSyncCycle(logPath, dataDir);

    const elapsed = Date.now() - cycleStart;
    logMessage(logPath, `Cycle complete (${elapsed}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logMessage(logPath, `Cycle error: ${msg}`);
  }
}

/**
 * Main entry point for the watch worker process.
 */
async function main(): Promise<void> {
  const opts = parseArgs();
  const logPath = join(opts.dataDir, 'watch.log');

  logAndPrint(logPath, `Watch daemon started (PID: ${process.pid})`);
  logAndPrint(logPath, `Data directory: ${opts.dataDir}`);
  logAndPrint(logPath, `Poll interval: ${opts.intervalMs / 60000} minute(s)`);
  logAndPrint(logPath, `Log file: ${logPath}`);

  // Run first cycle immediately
  await runCycle(logPath, opts.dataDir);

  // Set up polling interval
  const intervalId = setInterval(async () => {
    await runCycle(logPath, opts.dataDir);
  }, opts.intervalMs);

  // Graceful shutdown
  function shutdown(signal: string): void {
    logAndPrint(logPath, `Received ${signal}, shutting down...`);
    clearInterval(intervalId);
    logAndPrint(logPath, 'Watch daemon stopped');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep the process alive
  process.stdin.resume();
}

// Only run when executed as the main module (child process fork)
main().catch((err) => {
  console.error(`[watch-worker] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
