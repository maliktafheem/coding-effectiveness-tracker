/**
 * CLI test-outcome command handler.
 *
 * Ingests local test result artifacts or manually specified command outcome
 * records and persists pass/fail/duration associations to the database.
 * Then correlates stored test outcomes with existing imported AI coding
 * sessions.
 *
 * Privacy-safe: reads only from local files; no remote CI/API calls.
 *
 * Idempotent: re-running with the same command+runAt+project does not
 * duplicate records.
 *
 * Supported input modes:
 * --outcome-json <path>  : Parse a JSON file containing an array of outcome
 *                          records with fields: command, passed, failed,
 *                          skipped, durationMs, runAt, sessionId, commitId.
 * --command <str>        : Specify the test command name.
 * --passed <n>           : Number of passed tests.
 * --failed <n>           : Number of failed tests.
 * --skipped <n>          : Number of skipped tests.
 * --duration <ms>        : Duration in milliseconds.
 * --run-at <datetime>    : ISO datetime when the test was run (defaults to now).
 * --session <id>         : Optional session ID to link outcome to.
 * --commit <hash>        : Optional commit hash to link outcome to.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { collectTestOutcomes, type TestOutcomeRecord } from '../collectors/test-outcomes.js';
import { correlateSession } from '../correlation/engine.js';
import { redactSecrets } from '../importers/privacy.js';

const InlineOutcomeSchema = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  runAt: z.string().datetime({ offset: true }).optional(),
  command: z.string().min(1),
});

const JsonOutcomeRecordSchema = z.object({
  command: z.string().min(1),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().optional().default(0),
  durationMs: z.number().int().nonnegative().optional().default(0),
  runAt: z.string().datetime({ offset: true }),
  sessionId: z.string().optional(),
  commitId: z.string().optional(),
  rawOutputSummary: z.string().optional(),
});

const JsonOutcomeFileSchema = z.array(JsonOutcomeRecordSchema);

interface TestOutcomeOptions {
  dataDir?: string;
  project?: string;
  outcomeJson?: string;
  command?: string;
  passed?: string;
  failed?: string;
  skipped?: string;
  duration?: string;
  runAt?: string;
  session?: string;
  commit?: string;
}

export async function handleTestOutcome(opts: TestOutcomeOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

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
    const db = storage.db;

    // Determine project
    const projectId = opts.project || 'default';

    // Ensure project exists
    const existingProject = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
    if (!existingProject) {
      db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);
    }

    const outcomes: TestOutcomeRecord[] = [];

    if (opts.outcomeJson) {
      // Mode 1: Parse from JSON file
      const jsonPath = isAbsolute(opts.outcomeJson) ? opts.outcomeJson : resolve(opts.outcomeJson);

      if (!existsSync(jsonPath)) {
        console.error('Error: Outcome file not found: ' + jsonPath);
        process.exit(1);
      }

      const st = statSync(jsonPath);
      if (!st.isFile()) {
        console.error('Error: Outcome path is not a file: ' + jsonPath);
        process.exit(1);
      }

      let rawContent: string;
      try {
        rawContent = readFileSync(jsonPath, 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Error: Failed to read outcome file: ' + message);
        process.exit(1);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        console.error('Error: Outcome file is not valid JSON: ' + jsonPath);
        process.exit(1);
      }

      const fileResult = JsonOutcomeFileSchema.safeParse(parsed);
      if (!fileResult.success) {
        for (const issue of fileResult.error.issues) {
          console.error('Error: ' + issue.path.join('.') + ' — ' + issue.message);
        }
        process.exit(1);
      }

      for (const record of fileResult.data) {
        outcomes.push({
          command: record.command,
          passed: record.passed,
          failed: record.failed,
          skipped: record.skipped,
          durationMs: record.durationMs,
          runAt: record.runAt,
          sessionId: record.sessionId,
          commitId: record.commitId,
          rawOutputSummary: record.rawOutputSummary
            ? redactSecrets(record.rawOutputSummary)
            : undefined,
        });
      }
    } else if (opts.command) {
      // Mode 2: Single inline outcome
      const inlineResult = InlineOutcomeSchema.safeParse({
        passed: opts.passed !== undefined ? Number(opts.passed) : 0,
        failed: opts.failed !== undefined ? Number(opts.failed) : 0,
        skipped: opts.skipped !== undefined ? Number(opts.skipped) : 0,
        durationMs: opts.duration !== undefined ? Number(opts.duration) : 0,
        runAt: opts.runAt,
        command: opts.command,
      });

      if (!inlineResult.success) {
        for (const issue of inlineResult.error.issues) {
          console.error('Error: ' + issue.path.join('.') + ' — ' + issue.message);
        }
        process.exit(1);
      }

      const { passed, failed, skipped, durationMs, runAt } = inlineResult.data;
      const effectiveRunAt = runAt || new Date().toISOString();

      // Resolve session ID if provided by external_id
      const sessionId = opts.session;
      if (sessionId) {
        // Check if the session exists
        const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as { id: string } | undefined;
        if (!session) {
          console.error('Error: Session not found: ' + sessionId);
          console.error('Use "cet report --json" to list available session IDs.');
          process.exit(1);
        }
      }

      // Resolve commit ID if provided by hash
      let commitId = opts.commit;
      if (commitId) {
        const commit = db.prepare('SELECT id FROM git_commits WHERE hash = ? OR short_hash = ?').get(commitId, commitId) as { id: string } | undefined;
        if (commit) {
          commitId = commit.id;
        }
        // If commit not found, still store the hash value as-is
      }

      outcomes.push({
        command: opts.command,
        passed,
        failed,
        skipped,
        durationMs,
        runAt: effectiveRunAt,
        sessionId,
        commitId,
      });
    } else {
      console.error('Error: Provide either --outcome-json <path> or --command <str> with result counts.');
      console.error('');
      console.error('Usage:');
      console.error('  cet test-outcome --outcome-json <path>            Ingest from JSON artifact');
      console.error('  cet test-outcome --command "npm test" --passed 10 --failed 0');
      console.error('');
      console.error('Options:');
      console.error('  --outcome-json <path>  JSON file with array of test outcome records');
      console.error('  --command <str>        Test command name');
      console.error('  --passed <n>           Number of passed tests (default: 0)');
      console.error('  --failed <n>           Number of failed tests (default: 0)');
      console.error('  --skipped <n>          Number of skipped tests (default: 0)');
      console.error('  --duration <ms>        Duration in milliseconds (default: 0)');
      console.error('  --run-at <datetime>    ISO datetime of the test run (default: now)');
      console.error('  --project <id>         Project ID (default: "default")');
      console.error('  --session <id>         Session ID to link outcome to');
      console.error('  --commit <hash>        Commit hash to link outcome to');
      process.exit(1);
    }

    if (outcomes.length === 0) {
      console.log('No test outcomes to ingest.');
      return;
    }

    // Store outcomes (idempotent — skips duplicate command+runAt+project)
    const stored = collectTestOutcomes(storage, outcomes, projectId);

    // Correlate with sessions
    let correlationCount = 0;
    if (stored > 0) {
      const sessions = db.prepare(
        'SELECT id FROM sessions WHERE project_id = ?'
      ).all(projectId) as { id: string }[];

      for (const session of sessions) {
        const correlations = correlateSession(storage, session.id);
        correlationCount += correlations.length;
      }
    }

    // Output summary
    console.log('Test outcome ingest complete.');
    console.log('  Project: ' + projectId);
    console.log('  Outcomes in input: ' + outcomes.length);
    console.log('  New outcomes stored: ' + stored);
    console.log('  Skipped (duplicate): ' + (outcomes.length - stored));
    if (stored > 0) {
      console.log('  Correlations updated: ' + correlationCount);
    }
    console.log('');
    console.log('Privacy: All data stays local. No remote CI/API calls were made.');
  } finally {
    storage?.close();
  }
}

