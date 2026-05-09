/**
 * CLI report command handler.
 *
 * Generates effectiveness report from imported, correlated data.
 * Supports filtering by project, tool, date range, and JSON output.
 */

import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { computeEffectivenessScore } from '../scoring/effectiveness.js';

interface ReportOptions {
  dataDir?: string;
  json?: boolean;
  tool?: string;
  project?: string;
  from?: string;
  to?: string;
}

export async function handleReport(opts: ReportOptions): Promise<void> {
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

    // Build session query with filters
    let sessionQuery = 'SELECT * FROM sessions WHERE 1=1';
    const params: string[] = [];

    if (opts.tool) {
      sessionQuery += ' AND source_tool_id = ?';
      params.push(opts.tool);
    }
    if (opts.project) {
      sessionQuery += ' AND project_id = ?';
      params.push(opts.project);
    }
    if (opts.from) {
      sessionQuery += ' AND started_at >= ?';
      params.push(opts.from.length === 10 ? opts.from + 'T00:00:00Z' : opts.from);
    }
    if (opts.to) {
      sessionQuery += ' AND started_at <= ?';
      params.push(opts.to.length === 10 ? opts.to + 'T23:59:59Z' : opts.to);
    }

    const sessions = db.prepare(sessionQuery).all(...params) as Record<string, unknown>[];

    if (sessions.length === 0) {
      if (opts.json) {
        console.log(JSON.stringify({
          score: { aggregate: 0, dimensions: [], missingInputs: ['No sessions available.'] },
          sessions: [],
          sources: [],
          period: { from: opts.from || null, to: opts.to || null },
          message: 'No sessions found. Import data with: cet import --fixture <path>',
        }, null, 2));
      } else {
        console.log('No sessions found. Import data with: cet import --fixture <path>');
      }
      return;
    }

    // Compute effectiveness score
    const score = computeEffectivenessScore(storage, {
      projectId: opts.project,
      toolId: opts.tool,
      from: opts.from,
      to: opts.to,
    });

    // Gather source tools
    const sources = [...new Set(sessions.map((s) => s.source_tool_id as string))];

    // Gather cost/token/rework data per session
    const enrichedSessions = sessions.map((s) => {
      const enriched: Record<string, unknown> = {
        id: s.id,
        external_id: s.external_id,
        source_tool_id: s.source_tool_id,
        project_id: s.project_id,
        started_at: s.started_at,
        ended_at: s.ended_at,
        summary: s.summary,
        model: s.model,
        tokensInput: s.tokens_input,
        tokensOutput: s.tokens_output,
        costEstimate: s.cost_estimate,
      };

      // Parse metadata for rework indicators
      if (s.metadata_json) {
        try {
          enriched.metadata = JSON.parse(s.metadata_json as string);
        } catch {
          enriched.metadata = {};
        }
      }

      // Attach correlations
      const correlations = db.prepare('SELECT * FROM correlations WHERE session_id = ?').all(s.id) as Record<string, unknown>[];
      enriched.correlations = correlations.map((c) => ({
        type: c.correlation_type,
        targetId: c.target_id,
        confidence: c.confidence,
        reasons: c.metadata_json ? JSON.parse(c.metadata_json as string).reasons : [],
      }));

      // Attach outcomes
      const outcomes = db.prepare('SELECT * FROM outcomes WHERE session_id = ?').all(s.id) as Record<string, unknown>[];
      enriched.outcomes = outcomes.map((o) => ({
        type: o.outcome_type,
        label: o.label,
        score: o.score,
        note: o.note,
      }));

      return enriched;
    });

    if (opts.json) {
      const output = {
        score: {
          aggregate: score.aggregate,
          dimensions: score.dimensions,
          missingInputs: score.missingInputs,
        },
        sessions: enrichedSessions,
        sources,
        period: {
          from: opts.from || score.dateRange.from,
          to: opts.to || score.dateRange.to,
        },
        totalSessions: sessions.length,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      // Human-readable output
      console.log('═══════════════════════════════════════════════');
      console.log('  Coding Effectiveness Report');
      console.log('═══════════════════════════════════════════════');
      console.log('');
      console.log(`  Sessions: ${sessions.length}`);
      console.log(`  Sources: ${sources.join(', ')}`);
      console.log(`  Period: ${opts.from || score.dateRange.from || 'N/A'} → ${opts.to || score.dateRange.to || 'N/A'}`);
      if (opts.tool) console.log(`  Filtered by tool: ${opts.tool}`);
      if (opts.project) console.log(`  Filtered by project: ${opts.project}`);
      console.log('');
      console.log('  ── Effectiveness Score ──────────────────────');
      console.log(`  Aggregate: ${Math.round(score.aggregate * 100)}%`);
      console.log('');
      for (const dim of score.dimensions) {
        const pct = Math.round(dim.value * 100);
        console.log(`  • ${dim.name}: ${pct}% — ${dim.explanation}`);
      }
      if (score.missingInputs.length > 0) {
        console.log('');
        console.log('  ── Missing/Partial Inputs ──────────────────');
        for (const m of score.missingInputs) {
          console.log(`  ⚠ ${m}`);
        }
      }
      console.log('');
      console.log('Privacy: All data stays local. No telemetry or external services.');
    }
  } finally {
    storage?.close();
  }
}
