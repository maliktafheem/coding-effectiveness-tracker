/**
 * CLI import command handler.
 *
 * Handles importing AI coding sessions from local tool data.
 * Supports: specific tool import, fixture import, explicit source, discover mode, dry-run, verbose.
 *
 * Key behaviors:
 * - Explicit --source paths are honored exactly; nonexistent sources exit non-zero.
 * - Unsupported explicit --source formats exit non-zero with validation error.
 * - Auto-discovery of real default tool directories requires --discover flag.
 * - --dry-run respects --source/--tool scoping and does not mutate DB.
 * - --verbose enables privacy-safe diagnostic logging (secrets/prompts are redacted).
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, extname } from 'node:path';
import { resolveDataDir, ensureInitialized } from '../config.js';
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
  discover?: boolean;
  verbose?: boolean;
}

/** Log only when --verbose is enabled. Messages are sanitized. */
function verboseLog(verbose: boolean, msg: string): void {
  if (verbose) {
    console.log('[verbose] ' + sanitizeForOutput(msg));
  }
}

/** Supported import file extensions. */
const SUPPORTED_EXTENSIONS = new Set(['.jsonl', '.json', '.js.', '.log']);

function isSupportedExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  // .js. files are also supported (e.g. sessions.js.)
  if (filePath.endsWith('.js.')) return true;
  return SUPPORTED_EXTENSIONS.has(ext);
}

export async function handleImport(opts: ImportOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const verbose = opts.verbose ?? false;

  ensureInitialized(dataDir);

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
      verboseLog(verbose, 'Fixture mode: resolving path ' + fixturePath);
      if (!existsSync(fixturePath)) {
        console.error('Error: Fixture file not found: ' + fixturePath);
        process.exit(1);
      }
      if (opts.dryRun) {
        console.log('[dry-run] Would import fixture: ' + fixturePath);
        const dryResult = runFixtureImport(fixturePath);
        console.log('[dry-run] ' + dryResult.sessions.length + ' session(s) would be imported from fixture');
        verboseLog(verbose, 'Dry-run fixture result: imported=' + dryResult.sessions.length + ' errors=' + dryResult.errors);
        return;
      }
      const result = runFixtureImport(fixturePath, storage);
      printResult('Fixture', fixturePath, result, verbose);
      return;
    }

    // Mode 2: Specific tool import (--tool + --source)
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
      const sourcePath = resolveExplicitSource(opts.source);
      verboseLog(verbose, 'Tool mode: tool=' + opts.tool + ' source=' + sourcePath);
      validateSourceExists(sourcePath);
      if (opts.dryRun) {
        const dryResult = runImport(importer, { sourcePath, dryRun: true });
        console.log('[dry-run] ' + importer.displayName + ': ' + dryResult.sessions.length + ' session(s) would be imported from ' + sourcePath);
        verboseLog(verbose, 'Dry-run result: sessions=' + dryResult.sessions.length + ' errors=' + dryResult.errors);
        if (dryResult.errors > 0) {
          for (const detail of dryResult.errorDetails) {
            console.error('  warning: ' + sanitizeForOutput(detail));
          }
        }
        return;
      }
      const result = runImport(importer, { sourcePath }, storage);
      printResult(importer.displayName, sourcePath, result, verbose);
      return;
    }

    // Mode 3: Explicit --source without --tool (try all importers against the path)
    if (opts.source) {
      const sourcePath = resolveExplicitSource(opts.source);
      verboseLog(verbose, 'Explicit source mode: ' + sourcePath);

      // Validate the path exists — no auto-discovery fallback
      if (!existsSync(sourcePath)) {
        console.error('Error: Source path not found: ' + sourcePath);
        process.exit(1);
      }

      // Check if the extension is supported (for files)
      const stat = existsSync(sourcePath);
      if (stat) {
        const st = statSync(sourcePath);
        if (st.isFile() && !isSupportedExtension(sourcePath)) {
          // Try to see if any importer can handle it before rejecting
          const importers = getImporters();
          const canHandle = importers.some((imp) => {
            try { return imp.canHandle(sourcePath); } catch { return false; }
          });
          if (!canHandle) {
            console.error('Error: Unsupported source format: ' + sourcePath);
            console.error('Supported file types: .jsonl, .json, .log');
            console.error('Use --tool <id> --source <path> to specify the tool explicitly.');
            process.exit(1);
          }
        }
      }

      // Discover which importers can handle this path
      const discovered = discoverImporters([sourcePath]);
      if (discovered.length === 0) {
        console.error('Error: No importer can handle source path: ' + sourcePath);
        console.error('The path does not appear to contain importable AI tool data.');
        console.error('Use --tool <id> --source <path> to specify the tool explicitly.');
        process.exit(1);
      }

      verboseLog(verbose, 'Discovered ' + discovered.length + ' importer(s) for source');

      if (opts.dryRun) {
        for (const { importer, path } of discovered) {
          const dryResult = runImport(importer, { sourcePath: path, dryRun: true });
          console.log('[dry-run] ' + importer.displayName + ': ' + dryResult.sessions.length + ' session(s) would be imported from ' + path);
          verboseLog(verbose, 'Dry-run ' + importer.toolId + ': sessions=' + dryResult.sessions.length + ' errors=' + dryResult.errors);
        }
        console.log('');
        console.log('Dry-run complete. No data was written.');
        return;
      }

      for (const { importer, path } of discovered) {
        const result = runImport(importer, { sourcePath: path }, storage);
        printResult(importer.displayName, path, result, verbose);
      }
      return;
    }

    // Mode 4: Auto-discovery (requires --discover flag)
    if (!opts.discover) {
      console.log('No explicit source specified. To import data, use one of:');
      console.log('  cet import --source <path>                    Import from an explicit path');
      console.log('  cet import --tool <id> --source <path>        Import from a specific tool');
      console.log('  cet import --fixture <path>                   Import from a fixture JSON file');
      console.log('  cet import --discover                         Scan default AI tool directories');
      console.log('');
      console.log('Available tools: ' + getImporters().map((i) => i.toolId + ' (' + i.displayName + ')').join(', '));
      return;
    }

    // --discover: scan default tool paths
    verboseLog(verbose, 'Auto-discovery mode: scanning default tool directories');
    const defaultPaths = getDefaultSourcePaths();
    const existingPaths = defaultPaths.filter((p) => existsSync(p));

    if (existingPaths.length === 0) {
      console.log('No AI tool data directories found.');
      console.log('Checked:');
      for (const p of defaultPaths) {
        verboseLog(verbose, '  checked: ' + p);
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
        verboseLog(verbose, 'Dry-run ' + importer.toolId + ': sessions=' + dryResult.sessions.length);
      }
      console.log('');
      console.log('Dry-run complete. No data was written.');
      return;
    }

    const results = importAll(existingPaths, {}, storage);
    for (const result of results) {
      printResult(result.sourceToolId, result.sourcePath, result, verbose);
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

/** Resolve an explicit source path to an absolute path. */
function resolveExplicitSource(source: string): string {
  return isAbsolute(source) ? source : resolve(source);
}

/** Validate that an explicit source path exists; exit non-zero if not. */
function validateSourceExists(sourcePath: string): void {
  if (!existsSync(sourcePath)) {
    console.error('Error: Source path not found: ' + sourcePath);
    process.exit(1);
  }
}

function printResult(toolName: string, sourcePath: string, result: ImportResult, verbose: boolean): void {
  const name = result.sourceToolId === 'fixture' ? 'Fixture' : toolName;
  verboseLog(verbose, name + ' result: imported=' + result.imported + ' skipped=' + result.skipped + ' errors=' + result.errors);
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



