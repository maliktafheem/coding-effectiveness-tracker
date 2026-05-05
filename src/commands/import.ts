/**
 * CLI import command handler.
 *
 * Handles importing AI coding sessions from local tool data.
 * Supports: specific tool import, fixture import, auto-discovery, dry-run.
 */

import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { resolveDataDir, isInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import {
  getImporters,
  discoverImporters,
  runImport,
  runFixtureImport,
  importAll,
} from '../importers/registry.js';
import { sanitizeForOutput } from '../importers/privacy.js';
import type { ImportResult } from '../importers/types.js';

interface ImportOptions {
  dataDir?: string;
  source?: string;
  tool?: string;
  fixture?: string;
  dryRun?: boolean;
}

export async function handleImport(opts: ImportOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  if (!isInitialized(dataDir)) {
    console.error('Error: Workspace not initialized. Run "cet init" first.');
    process.exit(1);
  }

  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });
  } catch (err) {
    if (err instanceof StorageError) {
      console.error('Error: ' + err.message);
      process.exit(1);
    }
    throw err;
  }

  try {
    // Mode 1: Fixture import (explicit JSON file)
    if (opts.fixture) {
      const fixturePath = isAbsolute(opts.fixture) ? opts.fixture : resolve(opts.fixture);
      if (!existsSync(fixturePath)) {
        console.error('Error: Fixture file not found: ' + fixturePath);
        process.exit(1);
      }
      if (opts.dryRun) {
        console.log('[dry-run] Would import fixture: ' + fixturePath);
        process.exit(0);
      }
      const result = runFixtureImport(fixturePath, storage);
      printResult('Fixture', fixturePath, result);
      return;
    }

    // Mode 2: Specific tool import
    if (opts.tool) {
      const importer = getImporters().find((i) => i.toolId === opts.tool);
      if (!importer) {
        console.error('Error: Unknown tool "' + opts.tool + '". Available: ' + getImporters().map((i) => i.toolId).join(', '));
        process.exit(1);
      }
      if (!opts.source) {
        console.error('Error: --source is required when using --tool.');
        process.exit(1);
      }
      const sourcePath = isAbsolute(opts.source) ? opts.source : resolve(opts.source);
      if (!existsSync(sourcePath)) {
        console.error('Error: Source path not found: ' + sourcePath);
        process.exit(1);
      }
      if (opts.dryRun) {
        const dryResult = runImport(importer, { sourcePath, dryRun: true });
        console.log('[dry-run] ' + importer.displayName + ': ' + dryResult.sessions.length + ' session(s) would be imported from ' + sourcePath);
        if (dryResult.errors > 0) {
          for (const detail of dryResult.errorDetails) {
            console.error('  warning: ' + sanitizeForOutput(detail));
          }
        }
        return;
      }
      const result = runImport(importer, { sourcePath }, storage);
      printResult(importer.displayName, sourcePath, result);
      return;
    }

    // Mode 3: Auto-discover and import from all known tool paths
    const defaultPaths = getDefaultSourcePaths();
    const existingPaths = defaultPaths.filter((p) => existsSync(p));

    if (existingPaths.length === 0) {
      console.log('No AI tool data directories found.');
      console.log('Checked:');
      for (const p of defaultPaths) {
        console.log('  - ' + p);
      }
      console.log('');
      console.log('Use --tool <id> --source <path> to import from a specific location.');
      console.log('Available tools: ' + getImporters().map((i) => i.toolId + ' (' + i.displayName + ')').join(', '));
      return;
    }

    console.log('Auto-discovered ' + existingPaths.length + ' AI tool data source(s):');
    for (const p of existingPaths) {
      console.log('  - ' + p);
    }

    if (opts.dryRun) {
      const discovered = discoverImporters(existingPaths);
      for (const { importer, path } of discovered) {
        const dryResult = runImport(importer, { sourcePath: path, dryRun: true });
        console.log('[dry-run] ' + importer.displayName + ': ' + dryResult.sessions.length + ' session(s) would be imported from ' + path);
      }
      console.log('');
      console.log('Dry-run complete. No data was written.');
      return;
    }

    const results = importAll(existingPaths, {}, storage);
    for (const result of results) {
      printResult(result.sourceToolId, result.sourcePath, result);
    }

    // Print summary
    const totalImported = results.reduce((sum, r) => sum + r.imported, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
    console.log('');
    console.log('Import complete: ' + totalImported + ' session(s) imported, ' + totalErrors + ' error(s).');
    if (totalImported > 0) {
      console.log('Privacy: All data stays local. Sensitive content is redacted by default.');
    }
  } finally {
    storage?.close();
  }
}

function printResult(toolName: string, sourcePath: string, result: ImportResult): void {
  const name = result.sourceToolId === 'fixture' ? 'Fixture' : toolName;
  if (result.imported > 0) {
    console.log(name + ': ' + result.imported + ' session(s) imported from ' + sourcePath);
  }
  if (result.skipped > 0) {
    console.log(name + ': ' + result.skipped + ' session(s) skipped (duplicate or malformed)');
  }
  if (result.errors > 0) {
    for (const detail of result.errorDetails) {
      console.error('  warning: ' + sanitizeForOutput(detail));
    }
  }
  if (result.imported === 0 && result.skipped === 0 && result.errors === 0) {
    console.log(name + ': No sessions found in ' + sourcePath);
  }
}

function getDefaultSourcePaths(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
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