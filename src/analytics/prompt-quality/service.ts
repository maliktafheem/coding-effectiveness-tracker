import type { Storage } from '../../storage.js';
import { getAnalyzer } from './registry.js';
import type { PromptQualityResult } from './types.js';

export interface ComputeOptions {
  recompute?: boolean;
  analyzerId?: string;
}

export interface ComputeSummary {
  computed: number;
  skipped: number;
}

export interface StoredResult {
  sessionId: string;
  toolId: string;
  startedAt: string | null;
  overall: number;
  signals: Record<string, number>;
  analyzerId: string;
  analyzerVersion: string;
  computedAt: string;
}

/**
 * Compute and store prompt quality for one session.
 * - If recompute=false and already cached, returns the cached result without running analyzer.
 * - Returns null only when session does not exist.
 */
export async function computeSingle(
  storage: Storage,
  sessionId: string,
  opts: ComputeOptions = {},
): Promise<PromptQualityResult | null> {
  const db = storage.db;

  if (!opts.recompute) {
    const existing = db
      .prepare('SELECT prompt_quality_json FROM sessions WHERE id = ? AND prompt_quality_json IS NOT NULL')
      .get(sessionId) as { prompt_quality_json: string } | undefined;
    if (existing) return JSON.parse(existing.prompt_quality_json) as PromptQualityResult;
  }

  const session = db
    .prepare('SELECT id, source_tool_id, started_at FROM sessions WHERE id = ?')
    .get(sessionId) as { id: string; source_tool_id: string; started_at: string | null } | undefined;
  if (!session) return null;

  const eventRows = db
    .prepare(
      'SELECT id, event_type, occurred_at, summary, metadata_json FROM events WHERE session_id = ? ORDER BY occurred_at',
    )
    .all(sessionId) as { id: string; event_type: string; occurred_at: string | null; summary: string | null; metadata_json: string | null }[];

  const analyzer = getAnalyzer(opts.analyzerId);
  const result = await analyzer.analyze({
    session: {
      id: session.id,
      sourceToolId: session.source_tool_id,
      startedAt: session.started_at,
    },
    events: eventRows.map((e) => ({
      id: e.id,
      sessionId: session.id,
      eventType: e.event_type,
      occurredAt: e.occurred_at,
      summary: e.summary,
      metadataJson: e.metadata_json,
    })),
  });

  db.prepare('UPDATE sessions SET prompt_quality_json = ? WHERE id = ?').run(
    JSON.stringify(result),
    sessionId,
  );

  return result;
}

/**
 * Compute for all sessions matching criteria.
 * - default: only sessions where prompt_quality_json IS NULL
 * - recompute=true: all sessions
 * Returns { computed, skipped } counts.
 */
export async function computeAll(
  storage: Storage,
  opts: ComputeOptions = {},
): Promise<ComputeSummary> {
  const db = storage.db;

  // Pre-count already-cached sessions (skipped) before computing
  let skipped = 0;
  if (!opts.recompute) {
    const cached = db
      .prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE prompt_quality_json IS NOT NULL')
      .get() as { cnt: number };
    skipped = cached.cnt;
  }

  const rows = opts.recompute
    ? (db.prepare('SELECT id FROM sessions').all() as { id: string }[])
    : (db.prepare('SELECT id FROM sessions WHERE prompt_quality_json IS NULL').all() as { id: string }[]);

  let computed = 0;
  for (const { id } of rows) {
    await computeSingle(storage, id, opts);
    computed++;
  }

  return { computed, skipped };
}

/**
 * Return all sessions that have a stored prompt quality result, joined with
 * session identity fields. Ordered by started_at DESC (most recent first).
 */
export function getAllResults(storage: Storage): StoredResult[] {
  const rows = storage.db
    .prepare(
      `SELECT id, source_tool_id, started_at, prompt_quality_json
       FROM sessions
       WHERE prompt_quality_json IS NOT NULL
       ORDER BY started_at DESC`,
    )
    .all() as { id: string; source_tool_id: string; started_at: string | null; prompt_quality_json: string }[];

  return rows.map((r) => {
    const parsed = JSON.parse(r.prompt_quality_json) as PromptQualityResult;
    return {
      sessionId: r.id,
      toolId: r.source_tool_id,
      startedAt: r.started_at,
      overall: parsed.overall,
      signals: parsed.signals,
      analyzerId: parsed.analyzerId,
      analyzerVersion: parsed.analyzerVersion,
      computedAt: parsed.computedAt,
    };
  });
}

/**
 * Get stored prompt quality for a single session. Returns null if not computed yet.
 */
export function getResult(storage: Storage, sessionId: string): PromptQualityResult | null {
  const row = storage.db
    .prepare('SELECT prompt_quality_json FROM sessions WHERE id = ?')
    .get(sessionId) as { prompt_quality_json: string | null } | undefined;
  if (!row || !row.prompt_quality_json) return null;
  return JSON.parse(row.prompt_quality_json) as PromptQualityResult;
}
