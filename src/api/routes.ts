import type { FastifyInstance } from 'fastify';
import type { ServerOptions } from './server.js';
import { resolveDataDir, isInitialized } from '../config.js';
import { Storage } from '../storage.js';
import { computeEffectivenessScore } from '../scoring/effectiveness.js';
import { randomUUID } from 'node:crypto';
import { generateJsonExport, generateMarkdownExport } from './export.js';

const VALID_OUTCOMES = new Set([
  'good','accepted','merged','shipped','ok','neutral','partial',
  'poor','rejected','reverted','abandoned','unknown',
]);

export function registerRoutes(app: FastifyInstance, opts: ServerOptions): void {
  const dataDir = resolveDataDir(opts.dataDir);

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/api/overview', async (_request, reply) => {
    if (!isInitialized(dataDir)) {
      return reply.code(503).send({ error: 'Not initialized', message: 'Run cet init first' });
    }
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const sessions = db.prepare('SELECT * FROM sessions ORDER BY started_at').all() as Record<string, unknown>[];
      if (sessions.length === 0) {
        return {
          totalSessions: 0, tools: [], dateRange: { from: null, to: null },
          outcomeCount: 0, score: { aggregate: 0, dimensions: [], missingInputs: ['No sessions available.'] },
          empty: true, message: 'No sessions found. Import data with: cet import --fixture <path>',
        };
      }
      const tools = [...new Set(sessions.map(s => s.source_tool_id as string))];
      const score = computeEffectivenessScore(storage, {});
      const outcomeCount = (db.prepare('SELECT count(*) as cnt FROM outcomes').get() as { cnt: number }).cnt;
      return {
        totalSessions: sessions.length, tools,
        dateRange: score.dateRange, outcomeCount,
        score: { aggregate: score.aggregate, dimensions: score.dimensions, missingInputs: score.missingInputs },
        empty: false,
      };
    } finally { storage.close(); }
  });

  app.get('/api/timeline', async (request) => {
    const q = request.query as Record<string, string>;
    if (!isInitialized(dataDir)) return { sessions: [], total: 0 };
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      let sql = 'SELECT * FROM sessions WHERE 1=1';
      const params: (string|number)[] = [];
      if (q.tool) { sql += ' AND source_tool_id = ?'; params.push(q.tool); }
      if (q.project) { sql += ' AND project_id = ?'; params.push(q.project); }
      if (q.from) { sql += ' AND started_at >= ?'; params.push(q.from.length === 10 ? q.from + 'T00:00:00Z' : q.from); }
      if (q.to) { sql += ' AND started_at <= ?'; params.push(q.to.length === 10 ? q.to + 'T23:59:59Z' : q.to); }
      sql += ' ORDER BY started_at';
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      const sessions = rows.map(s => ({
        id: s.id, sourceToolId: s.source_tool_id, projectId: s.project_id,
        externalId: s.external_id, startedAt: s.started_at, endedAt: s.ended_at,
        durationMs: s.duration_ms, summary: s.summary, model: s.model,
      }));
      return { sessions, total: sessions.length };
    } finally { storage.close(); }
  });

  app.get('/api/tools', async () => {
    if (!isInitialized(dataDir)) return { tools: [] };
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const toolRows = db.prepare('SELECT DISTINCT source_tool_id FROM sessions').all() as { source_tool_id: string }[];
      const tools = toolRows.map(t => {
        const sessions = db.prepare('SELECT * FROM sessions WHERE source_tool_id = ?').all(t.source_tool_id) as Record<string, unknown>[];
        const score = computeEffectivenessScore(storage, { toolId: t.source_tool_id });
        const outcomeCount = (db.prepare(
          'SELECT count(*) as cnt FROM outcomes o JOIN sessions s ON o.session_id = s.id WHERE s.source_tool_id = ?'
        ).get(t.source_tool_id) as { cnt: number }).cnt;
        return {
          toolId: t.source_tool_id, sessionCount: sessions.length,
          outcomeCount, score: score.aggregate,
        };
      });
      return { tools };
    } finally { storage.close(); }
  });

  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isInitialized(dataDir)) return reply.code(503).send({ error: 'Not initialized' });
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      const correlations = (db.prepare('SELECT * FROM correlations WHERE session_id = ?').all(id) as Record<string, unknown>[]).map(c => ({
        id: c.id, type: c.correlation_type, targetId: c.target_id, confidence: c.confidence,
        reasons: c.metadata_json ? JSON.parse(c.metadata_json as string).reasons : [],
      }));
      const outcomes = (db.prepare('SELECT * FROM outcomes WHERE session_id = ?').all(id) as Record<string, unknown>[]).map(o => ({
        id: o.id, type: o.outcome_type, label: o.label, score: o.score, note: o.note,
      }));
      return {
        id: session.id, sourceToolId: session.source_tool_id, projectId: session.project_id,
        externalId: session.external_id, startedAt: session.started_at, endedAt: session.ended_at,
        durationMs: session.duration_ms, summary: session.summary, model: session.model,
        tokensInput: session.tokens_input, tokensOutput: session.tokens_output,
        costEstimate: session.cost_estimate,
        metadata: session.metadata_json ? JSON.parse(session.metadata_json as string) : null,
        correlations, outcomes, uncorrelated: correlations.length === 0,
      };
    } finally { storage.close(); }
  });

  app.post('/api/sessions/:id/annotations', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    if (!body.outcome || typeof body.outcome !== 'string' || body.outcome.trim() === '') {
      return reply.code(400).send({ error: 'Outcome is required and must be a non-empty string' });
    }
    const outcome = (body.outcome as string).toLowerCase().trim();
    if (!VALID_OUTCOMES.has(outcome)) {
      return reply.code(400).send({ error: 'Invalid outcome. Accepted: ' + Array.from(VALID_OUTCOMES).join(', ') });
    }
    if (!isInitialized(dataDir)) return reply.code(503).send({ error: 'Not initialized' });
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      if (typeof body.score === 'number' && (body.score < 0 || body.score > 1)) {
        return reply.code(400).send({ error: 'Score must be between 0 and 1' });
      }
      const annId = randomUUID();
      const note = typeof body.note === 'string' ? body.note : null;
      const score = typeof body.score === 'number' ? body.score : null;
      const tagsJson = body.tags ? JSON.stringify(body.tags) : null;
      db.prepare(
        'INSERT INTO outcomes (id, session_id, outcome_type, score, label, note, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(annId, id, 'manual', score, outcome, note, tagsJson);
      return reply.code(201).send({
        id: annId, sessionId: id, outcome, score, note,
        createdAt: new Date().toISOString(),
      });
    } finally { storage.close(); }
  });

  app.patch('/api/annotations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    if (!isInitialized(dataDir)) return reply.code(503).send({ error: 'Not initialized' });
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const existing = db.prepare('SELECT * FROM outcomes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!existing) return reply.code(404).send({ error: 'Annotation not found' });
      const outcome = typeof body.outcome === 'string' ? body.outcome.toLowerCase().trim() : (existing.label as string);
      if (!VALID_OUTCOMES.has(outcome)) {
        return reply.code(400).send({ error: 'Invalid outcome' });
      }
      const score = typeof body.score === 'number' ? body.score : (existing.score as number | null);
      const note = typeof body.note === 'string' ? body.note : (existing.note as string | null);
      db.prepare('UPDATE outcomes SET label = ?, score = ?, note = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(outcome, score, note, id);
      return { id, sessionId: existing.session_id, outcome, score, note };
    } finally { storage.close(); }
  });

  app.get('/api/export/json', async (request) => {
    const q = request.query as Record<string, string>;
    if (!isInitialized(dataDir)) return { sessions: [], score: { aggregate: 0 }, tools: [], empty: true };
    const storage = Storage.open({ dataDir });
    try {
      return generateJsonExport(storage, { toolId: q.tool, projectId: q.project, from: q.from, to: q.to });
    } finally { storage.close(); }
  });

  app.get('/api/export/markdown', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (!isInitialized(dataDir)) return reply.type('text/markdown').send('# No Data\nNo sessions available.');
    const storage = Storage.open({ dataDir });
    try {
      const md = generateMarkdownExport(storage, { toolId: q.tool, projectId: q.project, from: q.from, to: q.to });
      return reply.type('text/markdown').send(md);
    } finally { storage.close(); }
  });
}
