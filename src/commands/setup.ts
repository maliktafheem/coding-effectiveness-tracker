/**
 * CLI setup command handler.
 *
 * `cet setup` — one-command onboarding that:
 * 1. Initializes the workspace (auto-init if needed)
 * 2. Auto-discovers AI tool directories and imports sessions
 * 3. Auto-detects git repo from CWD and syncs commits
 * 4. Starts the dashboard server (or skips with --no-serve)
 *
 * Supports --interactive mode for guided setup.
 *
 * Privacy: All data stays local. No telemetry or external services.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { createApiServer } from '../api/server.js';
import {
  getImporters,
  importAll,
  registerAllImporters,
} from '../importers/registry.js';
import { collectGitSignals, storeGitSignals } from '../collectors/git.js';
import { correlateSession } from '../correlation/engine.js';

interface SetupOptions {
  dataDir?: string;
  port?: string;
  serve?: boolean;  // --no-serve sets this to false (commander negation pattern)
  interactive?: boolean;
}

/**
 * Get default AI tool source paths for auto-discovery.
 * Reuses the logic from the import command.
 */
function getAutoDiscoverPaths(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const isWin32 = process.platform === 'win32';

  if (isWin32) {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return [
      join(home, '.claude'),
      join(home, '.claude', 'projects'),
      join(home, '.codex'),
      join(home, '.codex', 'sessions'),
      join(appData, 'opencode'),
      join(home, '.factory'),
      join(home, '.factory', 'sessions'),
      join(appData, 'Cursor'),
      join(home, '.cursor'),
    ];
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const xdgDataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share');

  return [
    join(home, '.claude'),
    join(home, '.claude', 'projects'),
    join(home, '.codex'),
    join(home, '.codex', 'sessions'),
    join(xdgConfigHome, 'opencode'),
    join(xdgDataHome, 'opencode'),
    join(home, '.factory'),
    join(home, '.factory', 'sessions'),
    join(xdgConfigHome, 'Cursor'),
    join(home, '.cursor'),
  ];
}

/**
 * Auto-discover AI tool directories and return paths that exist.
 */
function discoverToolDirectories(): string[] {
  registerAllImporters();
  const paths = getAutoDiscoverPaths();
  return paths.filter((p) => existsSync(p));
}

/**
 * Detect the nearest git repository by walking up parent directories
 * from the given start path. Returns null if none found.
 */
function detectGitRepo(startPath: string): string | null {
  let current = resolve(startPath);
  // Prevent infinite loop - max 50 levels up
  for (let i = 0; i < 50; i++) {
    if (existsSync(join(current, '.git'))) {
      const st = statSync(join(current, '.git'));
      if (st.isDirectory() || st.isFile()) {
        return current;
      }
    }
    const parent = resolve(current, '..');
    if (parent === current) break; // reached root
    current = parent;
  }
  return null;
}

export async function handleSetup(opts: SetupOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const port = parseInt(opts.port || '43187', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('Error: Invalid port number.');
    process.exit(1);
  }

  console.log('Coding Effectiveness Tracker — Setup');
  console.log('');

  // Step 1: Initialize workspace
  console.log('[1/4] Initializing workspace...');
  ensureInitialized(dataDir);
  console.log('  Workspace ready: ' + dataDir);
  console.log('');

  // Step 2: Auto-discover AI tool directories and import
  console.log('[2/4] Discovering AI tool data...');
  const toolPaths = discoverToolDirectories();

  if (toolPaths.length === 0) {
    console.log('  No AI tool data directories found.');
    console.log('');
    console.log('  To import AI coding sessions later, use:');
    console.log('    cet import --source <path>');
    console.log('    cet import --discover');
    console.log('');

    if (opts.interactive) {
      console.log('  You can specify a tool path manually:');
      console.log('    --tool <id> --source <path>');
      console.log('  Available tools: ' + getImporters().map((i) => i.toolId + ' (' + i.displayName + ')').join(', '));
      console.log('');
    }
  } else {
    console.log('  Found ' + toolPaths.length + ' AI tool data source(s):');
    for (const p of toolPaths) {
      console.log('    - ' + p);
    }

    let pathsToImport = toolPaths;

    if (opts.interactive) {
      console.log('');
      console.log('  Import from all discovered sources? [Y/n] ');
      // In interactive mode, we read from stdin
      // For non-TTY environments, we default to yes
      const answer = await readStdinLine();
      if (answer && answer.toLowerCase() === 'n') {
        // Ask user to pick specific tools
        console.log('  Enter tool IDs to import (comma-separated), or press Enter for all:');
        const tools = await readStdinLine();
        if (tools && tools.trim()) {
          const selectedTools = tools.split(',').map((t) => t.trim().toLowerCase());
          const importers = getImporters();
          pathsToImport = toolPaths.filter((p) => {
            for (const imp of importers) {
              if (selectedTools.includes(imp.toolId) && imp.canHandle(p)) {
                return true;
              }
            }
            return false;
          });
        }
      }
    }

    let storage: Storage | undefined;
    try {
      storage = Storage.open({ dataDir });
    } catch (err) {
      if (err instanceof StorageError) {
        console.error('Error: Failed to open database: ' + err.message);
        process.exit(1);
      }
      throw err;
    }

    try {
      const results = importAll(pathsToImport, {}, storage);
      const totalImported = results.reduce((sum, r) => sum + r.imported, 0);
      const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);

      for (const result of results) {
        if (result.imported > 0) {
          console.log('  ' + result.sourceToolId + ': ' + result.imported + ' session(s) imported');
        }
        if (result.errors > 0) {
          console.log('  ' + result.sourceToolId + ': ' + result.errors + ' error(s)');
        }
      }

      if (totalImported === 0 && totalErrors === 0) {
        console.log('  No sessions found in discovered directories.');
        console.log('  Try importing from a specific tool:');
        console.log('    cet import --tool claude-code --discover');
        console.log('    cet import --tool opencode --discover');
        console.log('    cet import --tool codex --discover');
      }

      console.log('  Import complete: ' + totalImported + ' session(s) imported, ' + totalErrors + ' error(s).');
    } finally {
      storage?.close();
    }
  }
  console.log('');

  // Step 3: Auto-detect git repo and sync
  console.log('[3/4] Detecting git repository...');
  const cwd = process.cwd();
  const repoPath = detectGitRepo(cwd);

  if (repoPath) {
    console.log('  Found git repository: ' + repoPath);

    if (opts.interactive) {
      console.log('  Use this repository for sync? [Y/n] ');
      const answer = await readStdinLine();
      if (answer && answer.toLowerCase() === 'n') {
        console.log('  Skipping git sync.');
        console.log('');
        console.log('[4/4] Setup complete! Run `cet sync --repo <path>` to sync a repository later.');
        if (opts.serve === false) {
          console.log('');
          console.log('Setup complete. All data stays local.');
        } else {
          await startDashboard(dataDir, port);
        }
        return;
      }
    }

    let storage: Storage | undefined;
    try {
      storage = Storage.open({ dataDir });
    } catch (err) {
      if (err instanceof StorageError) {
        console.error('Error: Failed to open database: ' + err.message);
        process.exit(1);
      }
      throw err;
    }

    try {
      const db = storage.db;
      const projectId = basename(repoPath).toLowerCase().replace(/[^a-z0-9-]/g, '-');

      // Ensure project exists
      const existingProject = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
      if (!existingProject) {
        db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(
          projectId,
          basename(repoPath),
          repoPath,
        );
      }

      const commits = collectGitSignals(repoPath);

      if (commits.length === 0) {
        console.log('  No commits found in repository.');
      } else {
        const stored = storeGitSignals(storage, commits, projectId);

        // Correlate commits with existing sessions
        const sessions = db.prepare(
          'SELECT id FROM sessions WHERE project_id = ?',
        ).all(projectId) as { id: string }[];

        let correlationCount = 0;
        for (const session of sessions) {
          const correlations = correlateSession(storage, session.id);
          correlationCount += correlations.length;
        }

        console.log('  Commits found: ' + commits.length);
        console.log('  New commits stored: ' + stored);
        console.log('  Sessions correlated: ' + sessions.length);
        console.log('  Correlations created: ' + correlationCount);
      }
    } finally {
      storage?.close();
    }
  } else {
    console.log('  No git repository found in: ' + cwd);
    console.log('  To sync a repository later, use: cet sync --repo <path>');
  }
  console.log('');

  // Step 4: Start dashboard or print success
  if (opts.serve === false) {
    console.log('[4/4] Dashboard not started (--no-serve).');
    console.log('');
    console.log('Setup complete. All data stays local.');
    console.log('');
    console.log('To start the dashboard:');
    console.log('  cet serve');
    console.log('');
    console.log('Other commands:');
    console.log('  cet import --discover    Discover and import AI tool data');
    console.log('  cet sync --repo <path>  Sync git commits from a repository');
    console.log('  cet report              View your effectiveness report');
    return;
  }

  await startDashboard(dataDir, port);
}

async function startDashboard(dataDir: string, port: number): Promise<void> {
  console.log('[4/4] Starting dashboard...');

  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });
  } catch (err) {
    if (err instanceof StorageError) {
      console.error('Error: Failed to open database: ' + err.message);
      process.exit(1);
    }
    throw err;
  }
  storage.close();

  try {
    const server = await createApiServer({ dataDir, port });
    await server.listen();
    console.log('  Dashboard running at: http://127.0.0.1:' + port);
    console.log('  Health check: http://127.0.0.1:' + port + '/health');
    console.log('');
    console.log('Privacy: All data stays local. No telemetry or external services.');
    console.log('');
    console.log('Press Ctrl+C to stop.');

    const shutdown = async () => {
      console.log('Shutting down...');
      await server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await new Promise<void>(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('EADDRINUSE')) {
      console.error('Error: Port ' + port + ' is already in use.');
      console.error('Try a different port: cet setup --port <port>');
      process.exit(1);
    }
    console.error('Error: ' + message);
    process.exit(1);
  }
}

/**
 * Read a line from stdin. Returns empty string if no TTY or no input.
 */
function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve('');
      return;
    }

    const { stdin } = process;
    let data = '';
    stdin.setEncoding('utf-8');
    stdin.once('data', (chunk: string) => {
      data = chunk.trim();
      resolve(data);
    });
  });
}
