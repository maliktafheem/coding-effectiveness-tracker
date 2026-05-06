import type { Storage } from '../storage.js';
import { computeEffectivenessScore } from '../scoring/effectiveness.js';

export interface ExportOptions {
  toolId?: string;
  projectId?: string;
  from?: string;
  to?: string;
}

export interface JsonExport {
  score: { aggregate: number; dimensions: unknown[]; missingInputs: string[] };
  sessions: Record<string, unknown>[];
  tools: string[];
  totalSessions: number;
  period: { from: string | null; to: string | null };
  empty: boolean;
  generatedAt: string;
}

export function generateJsonExport(storage: Storage, opts: ExportOptions): JsonExport {
  const db = storage.db;
  let sql = 'SELECT * FROM sessions WHERE 1=1';
  const params: (string|number)[] = [];
  if (opts.toolId) { sql += ' AND source_tool_id = ?'; params.push(opts.toolId); }
  if (opts.projectId) { sql += ' AND project_id = ?'; params.push(opts.projectId); }
  if (opts.from) { sql += ' AND started_at >= ?'; params.push(opts.from.length === 10 ? opts.from + 'T00:00:00Z' : opts.from); }
  if (opts.to) { sql += ' AND started_at <= ?'; params.push(opts.to.length === 10 ? opts.to + 'T23:59:59Z' : opts.to); }
  sql += ' ORDER BY started_at';
  const sessions = db.prepare(sql).all(...params) as Record<string, unknown>[];
  if (sessions.length === 0) {
    return {
      score: { aggregate: 0, dimensions: [], missingInputs: ['No sessions available.'] },
      sessions: [], tools: [], totalSessions: 0,
      period: { from: null, to: null }, empty: true,
      generatedAt: new Date().toISOString(),
    };
  }
  const score = computeEffectivenessScore(storage, {
    toolId: opts.toolId, projectId: opts.projectId, from: opts.from, to: opts.to,
  });
  const tools = [...new Set(sessions.map(s => s.source_tool_id as string))];
  const enriched = sessions.map(s => {
    const correlations = (db.prepare('SELECT * FROM correlations WHERE session_id = ?').all(s.id) as Record<string, unknown>[]).map(c => ({
      type: c.correlation_type, targetId: c.target_id, confidence: c.confidence,
      reasons: c.metadata_json ? JSON.parse(c.metadata_json as string).reasons : [],
    }));
    const outcomes = (db.prepare('SELECT * FROM outcomes WHERE session_id = ?').all(s.id) as Record<string, unknown>[]).map(o => ({
      type: o.outcome_type, label: o.label, score: o.score, note: o.note,
    }));
    return {
      id: s.id, sourceToolId: s.source_tool_id, projectId: s.project_id,
      startedAt: s.started_at, endedAt: s.ended_at, durationMs: s.duration_ms,
      summary: s.summary, model: s.model,
      tokensInput: s.tokens_input, tokensOutput: s.tokens_output,
      costEstimate: s.cost_estimate, correlations, outcomes,
    };
  });
  return {
    score: { aggregate: score.aggregate, dimensions: score.dimensions, missingInputs: score.missingInputs },
    sessions: enriched, tools, totalSessions: sessions.length,
    period: { from: score.dateRange.from, to: score.dateRange.to },
    empty: false, generatedAt: new Date().toISOString(),
  };
}

export function generateMarkdownExport(storage: Storage, opts: ExportOptions): string {
  const data = generateJsonExport(storage, opts);
  const lines: string[] = [];
  lines.push('# Coding Effectiveness Report');
  lines.push('');
  lines.push('Generated: ' + data.generatedAt);
  lines.push('Privacy: All data stays local. No telemetry or external services.');
  lines.push('');
  if (data.empty) {
    lines.push('**No sessions found.** Import data with: `cet import --fixture <path>`');
    return lines.join('\n');
  }
  lines.push('## Overview');
  lines.push('');
  lines.push('- **Total Sessions:** ' + data.totalSessions);
  lines.push('- **Tools:** ' + data.tools.join(', '));
  lines.push('- **Period:** ' + (data.period.from || 'N/A') + ' to ' + (data.period.to || 'N/A'));
  lines.push('- **Effectiveness Score:** ' + Math.round(data.score.aggregate * 100) + '%');
  lines.push('');
  lines.push('## Score Dimensions');
  lines.push('');
  for (const dim of data.score.dimensions as { name: string; value: number; explanation: string; available: boolean }[]) {
    const avail = dim.available ? '' : ' (unknown)';
    lines.push('- **' + dim.name + ':** ' + Math.round(dim.value * 100) + '%' + avail + ' - ' + dim.explanation);
  }
  if (data.score.missingInputs.length > 0) {
    lines.push('');
    lines.push('### Missing/Partial Inputs');
    for (const m of data.score.missingInputs) { lines.push('- ' + m); }
  }
  lines.push('');
  lines.push('## Tool Comparison');
  lines.push('');
  const toolMap = new Map<string, { count: number; sessions: Record<string, unknown>[] }>();
  for (const s of data.sessions as Record<string, unknown>[]) {
    const tid = s.sourceToolId as string;
    if (!toolMap.has(tid)) toolMap.set(tid, { count: 0, sessions: [] });
    const entry = toolMap.get(tid)!;
    entry.count++;
    entry.sessions.push(s);
  }
  lines.push('| Tool | Sessions |');
  lines.push('|------|----------|');
  for (const [tool, info] of toolMap) {
    lines.push('| ' + tool + ' | ' + info.count + ' |');
  }
  lines.push('');
  lines.push('## Sessions');
  lines.push('');
  for (const s of data.sessions as Record<string, unknown>[]) {
    lines.push('### ' + (s.summary || s.id));
    lines.push('- Tool: ' + s.sourceToolId);
    lines.push('- Started: ' + (s.startedAt || 'N/A'));
    if (s.model) lines.push('- Model: ' + s.model);
    const corrs = s.correlations as { type: string; confidence: number; reasons: string[] }[];
    if (corrs.length > 0) {
      lines.push('- Correlations: ' + corrs.map(c => c.type + ' (' + Math.round(c.confidence * 100) + '%)').join(', '));
    } else {
      lines.push('- Correlations: none (uncorrelated)');
    }
    const outs = s.outcomes as { type: string; label: string; score: number | null }[];
    if (outs.length > 0) {
      for (const o of outs) {
        const scoreStr = o.score != null ? ' (score: ' + Math.round(o.score * 100) + '%)' : '';
        lines.push('- Outcome: ' + o.label + scoreStr);
      }
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('Privacy: All data stays local. No telemetry or external services.');
  return lines.join('\n');
}
