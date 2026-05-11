/**
 * Importer registry — discovers and manages tool importers.
 *
 * Importers are registered externally (by CLI or tests) to avoid
 * circular module dependencies.
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ToolImporter, ImportOptions, ImportResult, NormalizedSession } from './types.js';
import { redactSecrets, redactMetadata, sanitizeForOutput } from './privacy.js';
import { Storage } from '../storage.js';
import { deriveProjectId, deriveProjectName } from '../project-identity.js';

/** All registered importers, keyed by tool id. */
const importers = new Map<string, ToolImporter>();

/** Register an importer. */
export function registerImporter(importer: ToolImporter): void {
  importers.set(importer.toolId, importer);
}

/** Get all registered importers. */
export function getImporters(): ToolImporter[] {
  return Array.from(importers.values());
}

/** Get an importer by tool id. */
export function getImporter(toolId: string): ToolImporter | undefined {
  return importers.get(toolId);
}

/** Auto-discover which importers can handle the given source paths. */
export function discoverImporters(sourcePaths: string[]): Array<{ importer: ToolImporter; path: string }> {
  const results: Array<{ importer: ToolImporter; path: string }> = [];
  for (const sourcePath of sourcePaths) {
    for (const importer of importers.values()) {
      try {
        if (importer.canHandle(sourcePath)) {
          results.push({ importer, path: sourcePath });
        }
      } catch {
        // Importer cannot access path — skip
      }
    }
  }
  return results;
}

/**
 * Run an import for a specific tool, parse sessions, and optionally write to storage.
 * Returns the import result with counts and diagnostics.
 */
export function runImport(
  importer: ToolImporter,
  options: ImportOptions,
  storage?: Storage,
): ImportResult {
  const result = importer.parse(options);

  // Apply redaction to all parsed sessions before storage
  for (const session of result.sessions) {
    if (session.summary) {
      session.summary = redactSecrets(session.summary);
    }
    if (session.metadata) {
      session.metadata = redactMetadata(session.metadata);
    }
    if (session.events) {
      for (const event of session.events) {
        if (event.summary) {
          event.summary = redactSecrets(event.summary);
        }
        if (event.metadata) {
          event.metadata = redactMetadata(event.metadata);
        }
      }
    }
  }

  if (options.dryRun || !storage) {
    return result;
  }

  // Write sessions to storage (idempotent — upserts via unique index)
  const db = storage.db;

  const countExisting = db.prepare(
    'SELECT id FROM sessions WHERE source_tool_id = ? AND external_id = ?',
  );

  const insertSession = db.prepare(`
    INSERT INTO sessions (id, source_tool_id, project_id, external_id, started_at, ended_at,
      duration_ms, summary, model, tokens_input, tokens_output, cost_estimate, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const updateSession = db.prepare(`
    UPDATE sessions SET
      project_id = ?, started_at = ?, ended_at = ?, duration_ms = ?,
      summary = ?, model = ?, tokens_input = ?, tokens_output = ?,
      cost_estimate = ?, metadata_json = ?, updated_at = datetime('now')
    WHERE source_tool_id = ? AND external_id = ?
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (id, session_id, event_type, occurred_at, summary, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let skipped = 0;

  // Auto-create projects referenced by sessions
  const ensureProject = db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)'
  );
  const updateProjectPath = db.prepare(
    'UPDATE projects SET path = ? WHERE id = ? AND path IS NULL'
  );

  const insertAll = db.transaction(() => {
    for (const session of result.sessions) {
      // Normalize project identity when full path is available
      const projectPath = session.metadata?.projectPath as string | undefined;
      if (projectPath) {
        const stableId = deriveProjectId(projectPath);
        const displayName = deriveProjectName(projectPath);
        ensureProject.run(stableId, displayName, projectPath);
        // Also update if path was missing (e.g., from fixture import)
        updateProjectPath.run(projectPath, stableId);
        session.projectId = stableId;
      }

      // Ensure project exists if referenced
      if (session.projectId) {
        ensureProject.run(session.projectId, session.projectId, null);
      }
      const toolId = session.sourceToolId || importer.toolId;
      if (!session.externalId) {
        skipped++;
        result.errorDetails.push('Skipped session with missing external ID');
        continue;
      }

      const existing = countExisting.get(toolId, session.externalId) as { id: string } | undefined;

      if (existing) {
        // Update existing record
        try {
          updateSession.run(
            session.projectId ?? null,
            session.startedAt ?? null,
            session.endedAt ?? null,
            session.durationMs ?? null,
            session.summary ?? null,
            session.model ?? null,
            session.tokensInput ?? null,
            session.tokensOutput ?? null,
            session.costEstimate ?? null,
            session.metadata ? JSON.stringify(session.metadata) : null,
            toolId,
            session.externalId,
          );
          imported++;
        } catch (err) {
          skipped++;
          const msg = err instanceof Error ? err.message : String(err);
          result.errorDetails.push(`Failed to update session ${sanitizeForOutput(session.externalId)}: ${sanitizeForOutput(msg)}`);
          result.errors++;
        }
      } else {
        // Insert new record
        const sessionId = randomUUID();
        try {
          insertSession.run(
            sessionId,
            toolId,
            session.projectId ?? null,
            session.externalId,
            session.startedAt ?? null,
            session.endedAt ?? null,
            session.durationMs ?? null,
            session.summary ?? null,
            session.model ?? null,
            session.tokensInput ?? null,
            session.tokensOutput ?? null,
            session.costEstimate ?? null,
            session.metadata ? JSON.stringify(session.metadata) : null,
          );

          if (session.events) {
            for (const event of session.events) {
              insertEvent.run(
                randomUUID(),
                sessionId,
                event.eventType,
                event.occurredAt ?? null,
                event.summary ?? null,
                event.metadata ? JSON.stringify(event.metadata) : null,
              );
            }
          }

          imported++;
        } catch (err) {
          skipped++;
          const msg = err instanceof Error ? err.message : String(err);
          result.errorDetails.push(`Failed to insert session ${sanitizeForOutput(session.externalId)}: ${sanitizeForOutput(msg)}`);
          result.errors++;
        }
      }
    }
  });
  insertAll();

  result.imported = imported;
  result.skipped = skipped;
  return result;
}

/**
 * Run fixture import — reads a JSON fixture file and imports all sessions.
 * Fixture format: array of NormalizedSession objects.
 */
export function runFixtureImport(
  fixturePath: string,
  storage?: Storage,
): ImportResult {
  if (!existsSync(fixturePath)) {
    return {
      sourceToolId: 'fixture',
      sourcePath: fixturePath,
      imported: 0,
      skipped: 0,
      errors: 1,
      errorDetails: [`Fixture file not found: ${fixturePath}`],
      sessions: [],
    };
  }

  let raw: unknown;
  try {
    const content = readFileSync(fixturePath, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      sourceToolId: 'fixture',
      sourcePath: fixturePath,
      imported: 0,
      skipped: 0,
      errors: 1,
      errorDetails: [`Failed to parse fixture file: ${sanitizeForOutput(msg)}`],
      sessions: [],
    };
  }

  if (!Array.isArray(raw)) {
    return {
      sourceToolId: 'fixture',
      sourcePath: fixturePath,
      imported: 0,
      skipped: 0,
      errors: 1,
      errorDetails: ['Fixture file must contain a JSON array of sessions'],
      sessions: [],
    };
  }

  const sessions: NormalizedSession[] = [];
  const errorDetails: string[] = [];
  let parseErrors = 0;

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    if (!item.externalId || !item.sourceToolId) {
      errorDetails.push(`Session at index ${i}: missing required fields (externalId, sourceToolId)`);
      parseErrors++;
      continue;
    }
    sessions.push(item as unknown as NormalizedSession);
  }

  const fixtureImporter: ToolImporter = {
    toolId: 'fixture',
    displayName: 'Fixture Import',
    canHandle: () => false,
    parse: () => ({
      sourceToolId: 'fixture',
      sourcePath: fixturePath,
      imported: 0,
      skipped: 0,
      errors: parseErrors,
      errorDetails,
      sessions,
    }),
  };

  const result = runImport(fixtureImporter, { sourcePath: fixturePath }, storage);
  result.errorDetails = [...errorDetails, ...result.errorDetails];
  result.errors += parseErrors;
  return result;
}

/**
 * Import from a specific tool source path using the identified importer.
 */
export function importFromTool(
  toolId: string,
  sourcePath: string,
  options: Partial<ImportOptions> = {},
  storage?: Storage,
): ImportResult {
  const importer = importers.get(toolId);
  if (!importer) {
    return {
      sourceToolId: toolId,
      sourcePath,
      imported: 0,
      skipped: 0,
      errors: 1,
      errorDetails: [`Unknown importer: ${toolId}`],
      sessions: [],
    };
  }

  return runImport(importer, { sourcePath, ...options }, storage);
}

/**
 * Import from all discovered tool source paths.
 */
export function importAll(
  sourcePaths: string[],
  options: Partial<ImportOptions> = {},
  storage?: Storage,
): ImportResult[] {
  const results: ImportResult[] = [];
  const discovered = discoverImporters(sourcePaths);

  for (const { importer, path } of discovered) {
    const result = runImport(importer, { sourcePath: path, ...options }, storage);
    results.push(result);
  }

  return results;
}
// ─── Built-in importer registration ──────────────────────────────────────────
import { ClaudeCodeImporter } from './claude-code.js';
import { CodexImporter } from './codex.js';
import { OpenCodeImporter } from './opencode.js';
import { FactoryDroidImporter } from './factory-droid.js';
import { CursorImporter } from './cursor.js';

/**
 * Register all built-in importers. Idempotent — safe to call multiple times.
 */
export function registerAllImporters(): void {
  registerImporter(new ClaudeCodeImporter());
  registerImporter(new CodexImporter());
  registerImporter(new OpenCodeImporter());
  registerImporter(new FactoryDroidImporter());
  registerImporter(new CursorImporter());
}

/**
 * Load custom importer plugins from a directory.
 *
 * Each plugin file should be a JavaScript module that exports a default
 * or named class implementing the ToolImporter interface.
 *
 * @param pluginsDir - Directory containing plugin .js/.mjs files
 * @param opts - Plugin loading options
 * @returns Number of plugins successfully loaded
 */
export async function loadPluginImporters(
  pluginsDir: string,
  opts: { enablePlugins?: boolean } = {},
): Promise<number> {
  if (!opts.enablePlugins) {
    return 0;
  }

  console.warn('[security] Plugin auto-load enabled — executing JS from data dir.');

  const { existsSync, readdirSync } = await import('node:fs');
  const { join, extname } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  if (!existsSync(pluginsDir)) return 0;

  let loaded = 0;
  const files = readdirSync(pluginsDir).filter((f: string) => {
    const ext = extname(f);
    return ext === '.js' || ext === '.mjs';
  });

  for (const file of files) {
    try {
      const fullPath = join(pluginsDir, file);
      const mod = await import(pathToFileURL(fullPath).href);
      // Find a constructor that looks like a ToolImporter (has prototype with canHandle)
      const ImporterClass = mod.default || Object.values(mod).find(
        (v: unknown) => {
          if (typeof v !== 'function') return false;
          const proto = (v as { prototype?: unknown }).prototype;
          return proto != null && typeof (proto as Record<string, unknown>).canHandle === 'function';
        }
      );

      if (!ImporterClass) {
        console.warn(`Warning: Skipping plugin ${file} — no valid ToolImporter exported.`);
        continue;
      }

      const instance = new (ImporterClass as unknown as new () => ToolImporter)();
      registerImporter(instance);
      loaded++;
    } catch (err) {
      console.warn(`Warning: Failed to load plugin ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return loaded;
}


