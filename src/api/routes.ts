import type { FastifyInstance } from 'fastify';
import type { ServerOptions } from './server.js';
import { resolveDataDir, isInitialized } from '../config.js';
import { Storage } from '../storage.js';
import { computeEffectivenessScore } from '../scoring/effectiveness.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { generateJsonExport, generateMarkdownExport } from './export.js';

const VALID_OUTCOMES = new Set([
  'good','accepted','merged','shipped','ok','neutral','partial',
  'poor','rejected','reverted','abandoned','unknown',
]);

// Zod schemas for annotation request validation
const annotationPostBodySchema = z.object({
  outcome: z.string().min(1, 'Outcome is required and must be a non-empty string'),
  score: z.number().min(0).max(1).optional().nullable(),
  note: z.string().optional().nullable(),
  tags: z.any().optional().nullable(),
});

const annotationPatchBodySchema = z.object({
  outcome: z.string().min(1, 'Outcome must be a non-empty string if provided.').optional().nullable(),
  score: z.number().min(0).max(1).optional().nullable(),
  note: z.string().optional().nullable(),
  tags: z.any().optional().nullable(),
});

/** Parse date param — returns ISO string or null. Validates format. */
function parseDateParam(val: string | undefined): string | null {
  if (!val) return null;
  if (val.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return val;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(val)) {
    return val;
  }
  return null;
}

/** Parse and validate common filter query params. Returns parsed filters or undefined with error sent. */
function parseFilterParams(q: Record<string, string>, reply: { code: (c: number) => { send: (o: unknown) => void } }): { tool?: string; project?: string; from?: string; to?: string; raw?: boolean } | undefined {
  const result: { tool?: string; project?: string; from?: string; to?: string; raw?: boolean } = {};

  if (q.tool !== undefined) {
    if (typeof q.tool !== 'string' || q.tool.length > 200) {
      reply.code(400).send({ error: 'Invalid tool filter parameter.' });
      return undefined;
    }
    result.tool = q.tool;
  }
  if (q.project !== undefined) {
    if (typeof q.project !== 'string' || q.project.length > 200) {
      reply.code(400).send({ error: 'Invalid project filter parameter.' });
      return undefined;
    }
    result.project = q.project;
  }
  if (q.from !== undefined) {
    const parsed = parseDateParam(q.from);
    if (!parsed) {
      reply.code(400).send({ error: 'Invalid from date format. Use YYYY-MM-DD or ISO 8601.' });
      return undefined;
    }
    result.from = q.from.length === 10 ? q.from + 'T00:00:00Z' : q.from;
  }
  if (q.to !== undefined) {
    const parsed = parseDateParam(q.to);
    if (!parsed) {
      reply.code(400).send({ error: 'Invalid to date format. Use YYYY-MM-DD or ISO 8601.' });
      return undefined;
    }
    result.to = q.to.length === 10 ? q.to + 'T23:59:59Z' : q.to;
  }
  if (q.raw !== undefined) {
    result.raw = q.raw === 'true';
  }
  return result;
}

export function registerRoutes(app: FastifyInstance, opts: ServerOptions): void {
  const dataDir = resolveDataDir(opts.dataDir);

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/api/overview', async (request, reply) => {
    if (!isInitialized(dataDir)) {
      return reply.code(503).send({ error: 'Not initialized', message: 'Run cet init first' });
    }
    const q = request.query as Record<string, string>;
    const filters = parseFilterParams(q, reply);
    if (!filters) return;

    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      let sql = 'SELECT * FROM sessions WHERE 1=1';
      const params: (string|number)[] = [];
      if (filters.tool) { sql += ' AND source_tool_id = ?'; params.push(filters.tool); }
      if (filters.project) { sql += ' AND project_id = ?'; params.push(filters.project); }
      if (filters.from) { sql += ' AND started_at >= ?'; params.push(filters.from); }
      if (filters.to) { sql += ' AND started_at <= ?'; params.push(filters.to); }
      sql += ' ORDER BY started_at';

      const sessions = db.prepare(sql).all(...params) as Record<string, unknown>[];
      if (sessions.length === 0) {
        return {
          totalSessions: 0, tools: [], dateRange: { from: null, to: null },
          outcomeCount: 0,
          score: { aggregate: 0, dimensions: [], missingInputs: ['No sessions available.'] },
          empty: true, message: 'No sessions found. Import data with: cet import --fixture <path>',
        };
      }
      const tools = [...new Set(sessions.map(s => s.source_tool_id as string))];
      const score = computeEffectivenessScore(storage, {
        toolId: filters.tool, projectId: filters.project,
        from: filters.from, to: filters.to,
      });
      let ocSql = 'SELECT count(*) as cnt FROM outcomes o JOIN sessions s ON o.session_id = s.id WHERE 1=1';
      const ocParams: (string|number)[] = [];
      if (filters.tool) { ocSql += ' AND s.source_tool_id = ?'; ocParams.push(filters.tool); }
      if (filters.project) { ocSql += ' AND s.project_id = ?'; ocParams.push(filters.project); }
      if (filters.from) { ocSql += ' AND s.started_at >= ?'; ocParams.push(filters.from); }
      if (filters.to) { ocSql += ' AND s.started_at <= ?'; ocParams.push(filters.to); }
      const outcomeCount = (db.prepare(ocSql).get(...ocParams) as { cnt: number }).cnt;
      return {
        totalSessions: sessions.length, tools,
        dateRange: score.dateRange, outcomeCount,
        score: { aggregate: score.aggregate, dimensions: score.dimensions, missingInputs: score.missingInputs },
        empty: false,
      };
    } finally { storage.close(); }
  });

  app.get('/api/timeline', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (!isInitialized(dataDir)) return { sessions: [], total: 0 };
    const filters = parseFilterParams(q, reply);
    if (!filters) return;

    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      let sql = 'SELECT * FROM sessions WHERE 1=1';
      const params: (string|number)[] = [];
      if (filters.tool) { sql += ' AND source_tool_id = ?'; params.push(filters.tool); }
      if (filters.project) { sql += ' AND project_id = ?'; params.push(filters.project); }
      if (filters.from) { sql += ' AND started_at >= ?'; params.push(filters.from); }
      if (filters.to) { sql += ' AND started_at <= ?'; params.push(filters.to); }
      sql += ' ORDER BY started_at';
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

      const sessions = rows.map(s => {
        const corrCount = (db.prepare('SELECT count(*) as cnt FROM correlations WHERE session_id = ?').get(s.id) as { cnt: number }).cnt;
        const outcomes = (db.prepare('SELECT label, score FROM outcomes WHERE session_id = ?').all(s.id) as { label: string; score: number | null }[]);
        const outcomeLabels = outcomes.map(o => o.label);
        const hasOutcome = outcomes.length > 0;
        let reworkCount = 0;
        if (s.metadata_json) {
          try {
            const meta = JSON.parse(s.metadata_json as string);
            if (typeof meta.reworkCount === 'number') reworkCount = meta.reworkCount;
          } catch { /* ignore */ }
        }
        return {
          id: s.id, sourceToolId: s.source_tool_id, projectId: s.project_id,
          externalId: s.external_id, startedAt: s.started_at, endedAt: s.ended_at,
          durationMs: s.duration_ms, summary: s.summary, model: s.model,
          correlationCount: corrCount,
          outcomeCount: outcomes.length,
          outcomeLabels,
          hasOutcome,
          reworkCount,
        };
      });
      return { sessions, total: sessions.length };
    } finally { storage.close(); }
  });

  app.get('/api/tools', async (request, reply) => {
    if (!isInitialized(dataDir)) return { tools: [] };
    const q = request.query as Record<string, string>;
    const filters = parseFilterParams(q, reply);
    if (!filters) return;

    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      // Build a filtered session query to scope each tool's data
      let sessionSql = 'SELECT DISTINCT source_tool_id FROM sessions WHERE 1=1';
      const sessionParams: (string|number)[] = [];
      if (filters.tool) { sessionSql += ' AND source_tool_id = ?'; sessionParams.push(filters.tool); }
      if (filters.project) { sessionSql += ' AND project_id = ?'; sessionParams.push(filters.project); }
      if (filters.from) { sessionSql += ' AND started_at >= ?'; sessionParams.push(filters.from); }
      if (filters.to) { sessionSql += ' AND started_at <= ?'; sessionParams.push(filters.to); }

      const toolRows = db.prepare(sessionSql).all(...sessionParams) as { source_tool_id: string }[];

      // Deduplicate tool IDs
      const toolIds = [...new Set(toolRows.map(t => t.source_tool_id))];

      const tools = toolIds.map(toolId => {
        // Count sessions for this tool with same filters
        let countSql = 'SELECT count(*) as cnt FROM sessions WHERE source_tool_id = ?';
        const countParams: (string|number)[] = [toolId];
        if (filters.project) { countSql += ' AND project_id = ?'; countParams.push(filters.project); }
        if (filters.from) { countSql += ' AND started_at >= ?'; countParams.push(filters.from); }
        if (filters.to) { countSql += ' AND started_at <= ?'; countParams.push(filters.to); }
        const { cnt: sessionCount } = db.prepare(countSql).get(...countParams) as { cnt: number };

        const score = computeEffectivenessScore(storage, {
          toolId, projectId: filters.project,
          from: filters.from, to: filters.to,
        });

        let outcomeCount: number;
        if (filters.project || filters.from || filters.to) {
          // Scope outcome count to filtered sessions
          const ocSql = 'SELECT count(*) as cnt FROM outcomes o JOIN sessions s ON o.session_id = s.id WHERE s.source_tool_id = ?' +
            (filters.project ? ' AND s.project_id = ?' : '') +
            (filters.from ? ' AND s.started_at >= ?' : '') +
            (filters.to ? ' AND s.started_at <= ?' : '');
          const ocParams: (string|number)[] = [toolId];
          if (filters.project) ocParams.push(filters.project);
          if (filters.from) ocParams.push(filters.from);
          if (filters.to) ocParams.push(filters.to);
          outcomeCount = (db.prepare(ocSql).get(...ocParams) as { cnt: number }).cnt;
        } else {
          outcomeCount = (db.prepare(
            'SELECT count(*) as cnt FROM outcomes o JOIN sessions s ON o.session_id = s.id WHERE s.source_tool_id = ?'
          ).get(toolId) as { cnt: number }).cnt;
        }

        return {
          toolId, sessionCount,
          outcomeCount, score: score.aggregate,
        };
      });
      return { tools };
    } finally { storage.close(); }
  });

  app.get('/api/projects', async () => {
    if (!isInitialized(dataDir)) return { projects: [] };
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const projectRows = db.prepare('SELECT DISTINCT project_id FROM sessions WHERE project_id IS NOT NULL ORDER BY project_id').all() as { project_id: string }[];
      const projects = projectRows.map(p => {
        const sessionCount = (db.prepare('SELECT count(*) as cnt FROM sessions WHERE project_id = ?').get(p.project_id) as { cnt: number }).cnt;
        return { projectId: p.project_id, sessionCount };
      });
      return { projects };
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
      let reworkCount = 0;
      let sessionMetadata: Record<string, unknown> | null = null;
      if (session.metadata_json) {
        try {
          const parsed = JSON.parse(session.metadata_json as string) as Record<string, unknown>;
          sessionMetadata = parsed;
          if (typeof parsed.reworkCount === 'number') reworkCount = parsed.reworkCount;
        } catch { /* ignore */ }
      }
      return {
        id: session.id, sourceToolId: session.source_tool_id, projectId: session.project_id,
        externalId: session.external_id, startedAt: session.started_at, endedAt: session.ended_at,
        durationMs: session.duration_ms, summary: session.summary, model: session.model,
        tokensInput: session.tokens_input, tokensOutput: session.tokens_output,
        costEstimate: session.cost_estimate,
        metadata: sessionMetadata, reworkCount,
        correlations, outcomes, uncorrelated: correlations.length === 0,
      };
    } finally { storage.close(); }
  });

  app.post('/api/sessions/:id/annotations', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!id || typeof id !== 'string' || id.trim() === '') {
      return reply.code(400).send({ error: 'Session ID is required' });
    }
    const parsed = annotationPostBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue.path.join('.');
      if (path === 'outcome') {
        return reply.code(400).send({ error: 'Outcome is required and must be a non-empty string' });
      }
      if (path === 'score') {
        return reply.code(400).send({ error: 'Score must be between 0 and 1' });
      }
      return reply.code(400).send({ error: issue.message });
    }
    const body = parsed.data;
    const outcome = body.outcome.toLowerCase().trim();
    if (!VALID_OUTCOMES.has(outcome)) {
      return reply.code(400).send({ error: 'Invalid outcome. Accepted: ' + Array.from(VALID_OUTCOMES).join(', ') });
    }
    if (!isInitialized(dataDir)) return reply.code(503).send({ error: 'Not initialized' });
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      const annId = randomUUID();
      const note = body.note ?? null;
      const score = body.score ?? null;
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
    if (!isInitialized(dataDir)) return reply.code(503).send({ error: 'Not initialized' });
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const existing = db.prepare('SELECT * FROM outcomes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!existing) return reply.code(404).send({ error: 'Annotation not found' });

      // Validate body with Zod schema before any mutation
      const parsed = annotationPatchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue.path.join('.');
        if (path === 'score') {
          return reply.code(400).send({ error: 'Score must be a number between 0 and 1.' });
        }
        if (path === 'outcome') {
          return reply.code(400).send({ error: 'Outcome must be a non-empty string if provided.' });
        }
        return reply.code(400).send({ error: issue.message });
      }
      const body = parsed.data;

      // Validate outcome against allowed set if provided
      if (body.outcome !== undefined && body.outcome !== null) {
        const outcomeVal = body.outcome.toLowerCase().trim();
        if (!VALID_OUTCOMES.has(outcomeVal)) {
          return reply.code(400).send({ error: 'Invalid outcome. Accepted: ' + Array.from(VALID_OUTCOMES).join(', ') });
        }
      }

      const outcome = body.outcome ? body.outcome.toLowerCase().trim() : (existing.label as string);
      const score = body.score ?? (existing.score as number | null);
      const note = body.note ?? (existing.note as string | null);
      db.prepare('UPDATE outcomes SET label = ?, score = ?, note = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(outcome, score, note, id);
      return { id, sessionId: existing.session_id, outcome, score, note };
    } finally { storage.close(); }
  });

  app.get('/api/export/json', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (!isInitialized(dataDir)) return { sessions: [], score: { aggregate: 0 }, tools: [], empty: true };
    const filters = parseFilterParams(q, reply);
    if (!filters) return;

    const storage = Storage.open({ dataDir });
    try {
      return generateJsonExport(storage, {
        toolId: filters.tool, projectId: filters.project,
        from: filters.from, to: filters.to, raw: filters.raw,
      });
    } finally { storage.close(); }
  });

  app.get('/api/export/markdown', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (!isInitialized(dataDir)) return reply.type('text/markdown').send('# No Data\nNo sessions available.');
    const filters = parseFilterParams(q, reply);
    if (!filters) return;

    const storage = Storage.open({ dataDir });
    try {
      const md = generateMarkdownExport(storage, {
        toolId: filters.tool, projectId: filters.project,
        from: filters.from, to: filters.to, raw: filters.raw,
      });
      return reply.type('text/markdown').send(md);
    } finally { storage.close(); }
  });
}
