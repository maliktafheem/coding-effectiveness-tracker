import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { Storage, StorageError } from './storage.js';

const DEFAULT_DIR_NAME = 'coding-effectiveness-tracker';

/**
 * Resolve the data directory for the tracker.
 * Priority: explicit option > CET_DATA_DIR env > platform default.
 * On Windows: %LOCALAPPDATA%/coding-effectiveness-tracker
 * On others:  ~/.coding-effectiveness-tracker
 */
export function resolveDataDir(explicit?: string): string {
  if (explicit) {
    return isAbsolute(explicit) ? explicit : resolve(explicit);
  }

  const envDir = process.env.CET_DATA_DIR;
  if (envDir) {
    return isAbsolute(envDir) ? envDir : resolve(envDir);
  }

  const home = homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(localAppData, DEFAULT_DIR_NAME);
  }

  return join(home, `.${DEFAULT_DIR_NAME}`);
}

/**
 * Ensure the data directory and required subdirectories exist.
 * Returns the resolved path.
 */
export function ensureDataDir(dataDir: string): string {
  const resolved = resolveDataDir(dataDir);
  const subdirs = ['', 'importers', 'exports', 'correlations'];
  for (const sub of subdirs) {
    const dir = sub ? join(resolved, sub) : resolved;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  return resolved;
}

/**
 * Check if a data directory has been initialized (has config.db).
 */
export function isInitialized(dataDir: string): boolean {
  const resolved = resolveDataDir(dataDir);
  return existsSync(join(resolved, 'tracker.db'));
}

/**
 * Auto-initialize the workspace if not already initialized.
 * Creates the data directory, SQLite database, and default tool records silently.
 * Used by command handlers so users don't need to run "cet init" explicitly.
 */
export function ensureInitialized(dataDir: string): void {
  if (isInitialized(dataDir)) return;

  const resolved = resolveDataDir(dataDir);
  ensureDataDir(resolved);

  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir: resolved });
    const db = storage.db;

    const defaultTools = [
      { id: "claude-code", name: "claude-code", display_name: "Claude Code" },
      { id: "opencode", name: "opencode", display_name: "OpenCode" },
      { id: "codex", name: "codex", display_name: "Codex" },
      { id: "cursor", name: "cursor", display_name: "Cursor" },
      { id: "factory-droid", name: "factory-droid", display_name: "Factory Droid" },
    ];

    const insertTool = db.prepare(
      "INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)",
    );

    const insertAll = db.transaction(() => {
      for (const tool of defaultTools) {
        insertTool.run(tool.id, tool.name, tool.display_name);
      }
    });
    insertAll();

    storage.close();
  } catch (err) {
    if (err instanceof StorageError) {
      console.error('Error: Failed to auto-initialize workspace: ' + err.message);
      process.exit(1);
    }
    throw err;
  }
}