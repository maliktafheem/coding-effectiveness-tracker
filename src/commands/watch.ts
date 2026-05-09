/**
 * CLI watch command handler.
 *
 * Manages a background daemon process that keeps tracker data fresh:
 * - `cet watch`         — Starts the background daemon
 * - `cet watch --stop`  — Stops the running daemon
 * - `cet watch --status`— Checks daemon status
 *
 * The daemon forks a child process that polls every N minutes to
 * auto-initialize, import new AI sessions, and sync git commits.
 */

import { fork } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, ensureInitialized } from '../config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

interface WatchOptions {
  dataDir?: string;
  stop?: boolean;
  status?: boolean;
  interval?: string;
}

/**
 * Get the path to the PID file.
 */
function getPidPath(dataDir: string): string {
  return join(dataDir, 'watch.pid');
}

/**
 * Get the path to the watch log file.
 */
function getLogPath(dataDir: string): string {
  return join(dataDir, 'watch.log');
}

/**
 * Check if a process with the given PID is alive.
 * Uses process.kill with signal 0 (no signal sent, just checks existence).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the PID file and return the PID, or null if the file doesn't exist.
 */
function readPidFile(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  try {
    const content = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Write the PID to the PID file.
 */
function writePidFile(pidPath: string, pid: number): void {
  writeFileSync(pidPath, String(pid), 'utf-8');
}

/**
 * Remove the PID file.
 */
function removePidFile(pidPath: string): void {
  try {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Handle starting the watch daemon.
 */
async function handleStart(dataDir: string, intervalMinutes: number): Promise<void> {
  const pidPath = getPidPath(dataDir);
  const logPath = getLogPath(dataDir);

  // Check if daemon is already running
  const existingPid = readPidFile(pidPath);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    console.log(`Watch daemon already running (PID: ${existingPid})`);
    console.log(`Log file: ${logPath}`);
    return;
  }

  // Clean up stale PID file if process is dead
  if (existingPid !== null && !isProcessAlive(existingPid)) {
    console.log('Cleaning up stale PID file from previous instance...');
    removePidFile(pidPath);
  }

  // Ensure workspace is initialized before starting the daemon
  ensureInitialized(dataDir);

  // Resolve the worker module path
  const workerPath = join(__dirname, 'watch-worker.js');

  const child = fork(workerPath, [
    '--data-dir', dataDir,
    '--interval', String(intervalMinutes),
  ], {
    stdio: 'ignore',
    detached: true,
  });

  // Write PID file
  writePidFile(pidPath, child.pid!);

  console.log(`Watch daemon started (PID: ${child.pid})`);
  console.log(`Log file: ${logPath}`);
  console.log(`Poll interval: ${intervalMinutes} minute(s)`);

  // Unref the child so the parent can exit independently
  child.unref();

  // Handle child process errors (non-blocking - won't keep event loop alive)
  child.on('error', (err) => {
    console.error(`Watch daemon error: ${err.message}`);
    removePidFile(pidPath);
  });

  child.on('exit', (code, signal) => {
    if (code !== 0 && signal === null) {
      console.error(`Watch daemon exited with code ${code}`);
      removePidFile(pidPath);
    }
  });

  // Exit parent process so execFileSync in tests doesn't hang
  process.exit(0);
}

/**
 * Handle stopping the watch daemon.
 */
async function handleStop(dataDir: string): Promise<void> {
  const pidPath = getPidPath(dataDir);
  const pid = readPidFile(pidPath);

  if (pid === null) {
    console.log('Daemon not running');
    return;
  }

  if (isProcessAlive(pid)) {
    // Send SIGTERM (process.kill on Windows sends SIGTERM-equivalent)
    try {
      process.kill(pid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error stopping daemon: ${msg}`);
      // Clean up PID file even if kill fails
      removePidFile(pidPath);
      process.exit(1);
    }

    // Wait up to 5 seconds for clean exit
    const startTime = Date.now();
    const timeout = 5000;
    let exited = false;

    while (Date.now() - startTime < timeout) {
      if (!isProcessAlive(pid)) {
        exited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!exited) {
      console.error('Warning: Daemon did not exit within 5 seconds');
    }

    console.log(`Watch daemon stopped (PID: ${pid})`);
  } else {
    console.log('Daemon was not running, cleaned up stale PID');
  }

  removePidFile(pidPath);
}

/**
 * Handle checking the daemon status.
 */
async function handleStatus(dataDir: string): Promise<void> {
  const pidPath = getPidPath(dataDir);
  const logPath = getLogPath(dataDir);
  const pid = readPidFile(pidPath);

  if (pid === null) {
    console.log('Daemon not running');
    return;
  }

  if (isProcessAlive(pid)) {
    console.log(`Daemon running (PID: ${pid})`);
    console.log(`Log file: ${logPath}`);
  } else {
    console.log('Daemon not running (stale PID cleaned)');
    removePidFile(pidPath);
  }
}

/**
 * Main handler for the watch command.
 */
export async function handleWatch(opts: WatchOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  // --stop flag
  if (opts.stop) {
    await handleStop(dataDir);
    return;
  }

  // --status flag
  if (opts.status) {
    await handleStatus(dataDir);
    return;
  }

  // Parse interval
  let intervalMinutes = 10;
  if (opts.interval) {
    const parsed = parseInt(opts.interval, 10);
    if (isNaN(parsed) || parsed < 1) {
      console.error('Error: --interval must be a positive number (minimum 1)');
      process.exit(1);
    }
    intervalMinutes = parsed;
  }

  // Start the daemon
  await handleStart(dataDir, intervalMinutes);
}
