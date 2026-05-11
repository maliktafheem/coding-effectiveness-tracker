/**
 * CLI annotate command handler.
 *
 * Records manual outcome annotations for existing sessions.
 * Supports outcome labels, scores, notes, and tags.
 */

import { randomUUID } from 'node:crypto';
import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { redactSecrets } from '../importers/privacy.js';

/** Accepted outcome labels. */
const VALID_OUTCOMES = new Set([
  'good',
  'accepted',
  'merged',
  'shipped',
  'ok',
  'neutral',
  'partial',
  'poor',
  'rejected',
  'reverted',
  'abandoned',
  'unknown',
]);

interface AnnotateOptions {
  dataDir?: string;
  session: string;
  outcome: string;
  score?: string;
  note?: string;
  tags?: string;
}

export async function handleAnnotate(opts: AnnotateOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  ensureInitialized(dataDir);

  // Validate outcome
  const outcomeLabel = opts.outcome.toLowerCase().trim();
  if (!VALID_OUTCOMES.has(outcomeLabel)) {
    console.error('Error: Invalid outcome "' + opts.outcome + '".');
    console.error('Accepted values: ' + Array.from(VALID_OUTCOMES).join(', '));
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
    const db = storage.db;

    // Check session exists
    const session = db.prepare('SELECT id, external_id, source_tool_id FROM sessions WHERE id = ?').get(opts.session) as Record<string, unknown> | undefined;
    if (!session) {
      console.error(`Error: Session not found: ${opts.session}`);
      console.error('Use "cet report --json" to list available session IDs.');
      process.exit(1);
    }

    // Parse optional score
    let score: number | null = null;
    if (opts.score) {
      score = parseFloat(opts.score);
      if (isNaN(score) || score < 0 || score > 1) {
        console.error('Error: Score must be a number between 0 and 1.');
        process.exit(1);
      }
    }

    // Parse optional tags
    let tagsJson: string | null = null;
    if (opts.tags) {
      try {
        tagsJson = JSON.stringify(opts.tags.split(',').map((t) => t.trim()));
      } catch {
        tagsJson = JSON.stringify([opts.tags.trim()]);
      }
    }

    // Insert outcome with redacted note
    const outcomeId = randomUUID();
    db.prepare(`
      INSERT INTO outcomes (id, session_id, outcome_type, score, label, note, tags_json)
      VALUES (?, ?, 'manual', ?, ?, ?, ?)
    `).run(
      outcomeId,
      opts.session,
      score,
      outcomeLabel,
      opts.note ? redactSecrets(opts.note) : null,
      tagsJson,
    );

    console.log(`Annotation recorded for session ${session.external_id} (${session.source_tool_id}):`);
    console.log(`  Outcome: ${outcomeLabel}`);
    if (score !== null) console.log(`  Score: ${score}`);
    if (opts.note) console.log(`  Note: ${opts.note}`);
  } finally {
    storage?.close();
  }
}
