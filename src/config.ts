import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

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
