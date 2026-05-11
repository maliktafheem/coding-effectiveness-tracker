import type { FastifyInstance } from 'fastify';
import type { ServerOptions } from './server.js';
import { resolveDataDir, isInitialized } from '../config.js';
import { Storage } from '../storage.js';
import { computeScore } from '../scoring/score-service.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { generateJsonExport, generateMarkdownExport } from './export.js';
import { computeTrends } from '../analytics/trends.js';
import type {
  ErrorResponse,
  HealthResponse,
  AvailableToolsResponse,
  OverviewResponse,
  TimelineResponse,
  ToolsResponse,
  ProjectsResponse,
  TrendsResponse,
  SessionDetailResponse,
  SessionDiffResponse,
  AnnotationCreateResponse,
  AnnotationPatchResponse,
  JsonExportResponse,
  PromptQualityResponse,
} from './contract.js';
import { getSessionDiffs } from '../analytics/diff-service.js';
import { getAllResults, getResult } from '../analytics/prompt-quality/service.js';
import { deriveShipStatus, type ShipStatus } from '../correlation/ship-status.js';
import { redactSecrets } from '../importers/privacy.js';

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

  app.get('/health', async (): Promise<HealthResponse> => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  app.get('/api/available-tools', async (): Promise<AvailableToolsResponse> => {
    if (!isInitialized(dataDir)) return { tools: [] };
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const toolSessions = db.prepare('SELECT source_tool_id, count(*) as cnt FROM sessions GROUP BY source_tool_id').all() as { source_tool_id: string; cnt: number }[];
      const allTools = db.prepare('SELECT id, display_name FROM tools ORDER BY id').all() as { id: string; display_name: string }[];
      const tools = allTools.map((t) => ({ id: t.id, name: t.display_name || t.id, sessionCount: toolSessions.find((x) => x.source_tool_id === t.id)?.cnt || 0 }));
      tools.sort((a, b) => { if(a.id==='claude-code')return -1;if(b.id==='claude-code')return 1;if(a.id==='opencode')return -1;if(b.id==='opencode')return 1;if(a.id==='codex')return -1;if(b.id==='codex')return 1;return a.name.localeCompare(b.name); });
      return { tools };
    } finally { storage.close(); }
  });

  app.get('/api/trends', async (request): Promise<TrendsResponse> => {
    if (!isInitialized(dataDir)) return { points: [], period: { from: null, to: null } };
    const q = request.query as Record<string, string>;
    const storage = Storage.open({ dataDir });
    try { return computeTrends(storage, q.project, dataDir); } finally { storage.close(); }
  });

  app.get('/api/overview', async (request, reply): Promise<OverviewResponse | ErrorResponse | undefined> => {
    if (!isInitialized(dataDir)) {
      return reply.code(503).send({ error: 'Not initialized' });
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
        score: { aggregate: 0, dimensions: [], missingInputs: ['No sessions available.'], dataCompleteness: 0, evidenceLevel: 'insufficient' },
        empty: true, message: 'No sessions found. Import data with: cet import --fixture <path>',
        shipStatusBreakdown: { shipped: 0, reverted: 0, abandoned: 0, inFlight: 0, unlinked: 0, noPrData: 0 },
      };
      }
      const tools = [...new Set(sessions.map(s => s.source_tool_id as string))];
      const score = computeScore(storage, {
        dataDir: opts.dataDir,
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

      // Ship status breakdown
      const sessionIds = sessions.map(s => s.id as string);
      const shipMap = deriveShipStatus(db, sessionIds);
      const shipBreakdown = { shipped: 0, reverted: 0, abandoned: 0, inFlight: 0, unlinked: 0, noPrData: 0 };
      for (const s of sessionIds) {
        const v = shipMap.get(s);
        if (v === 'shipped') shipBreakdown.shipped++;
        else if (v === 'reverted') shipBreakdown.reverted++;
        else if (v === 'abandoned') shipBreakdown.abandoned++;
        else if (v === 'in-flight') shipBreakdown.inFlight++;
        else if (v === 'unlinked') shipBreakdown.unlinked++;
        else if (v === null) shipBreakdown.noPrData++;
      }

      return {
        totalSessions: sessions.length, tools,
        dateRange: score.dateRange, outcomeCount,
        score: {
          aggregate: score.aggregate,
          dimensions: score.dimensions,
          missingInputs: score.missingInputs,
          dataCompleteness: score.dataCompleteness,
          evidenceLevel: score.evidenceLevel,
        },
        empty: false,
        shipStatusBreakdown: shipBreakdown,
      };
    } finally { storage.close(); }
  });

  app.get('/api/timeline', async (request, reply): Promise<TimelineResponse | ErrorResponse | undefined> => {
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

      // Load all correlation counts and outcomes in bulk (eliminates N+1)
      const rowIds = rows.map(r => r.id as string);
      const corrCountMap = new Map<string, number>();
      const outcomesMap = new Map<string, { label: string; score: number | null }[]>();
      let shipStatusMap: Map<string, ShipStatus | null> = new Map();
      if (rowIds.length > 0) {
        const idsJson = JSON.stringify(rowIds);
        const corrRows = db.prepare(
          'SELECT session_id, count(*) as cnt FROM correlations WHERE session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id'
        ).all(idsJson) as { session_id: string; cnt: number }[];
        for (const cr of corrRows) corrCountMap.set(cr.session_id, cr.cnt);

        const outcomeRows = db.prepare(
          'SELECT session_id, label, score FROM outcomes WHERE session_id IN (SELECT value FROM json_each(?))'
        ).all(idsJson) as { session_id: string; label: string; score: number | null }[];
        for (const or of outcomeRows) {
          const list = outcomesMap.get(or.session_id) ?? [];
          list.push({ label: or.label, score: or.score });
          outcomesMap.set(or.session_id, list);
        }

        shipStatusMap = deriveShipStatus(db, rowIds);
      }

      const sessions = rows.map(s => {
        const corrCount = corrCountMap.get(s.id as string) ?? 0;
        const outcomes = outcomesMap.get(s.id as string) ?? [];
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
          id: s.id as string,
          sourceToolId: s.source_tool_id as string,
          projectId: (s.project_id as string | null) ?? null,
          externalId: (s.external_id as string | null) ?? null,
          startedAt: (s.started_at as string | null) ?? null,
          endedAt: (s.ended_at as string | null) ?? null,
          durationMs: (s.duration_ms as number | null) ?? null,
          summary: (s.summary as string | null) ?? null,
          model: (s.model as string | null) ?? null,
          correlationCount: corrCount,
          outcomeCount: outcomes.length,
          outcomeLabels,
          hasOutcome,
          reworkCount,
          shipStatus: shipStatusMap.get(s.id as string) ?? null,
        };
      });
      return { sessions, total: sessions.length };
    } finally { storage.close(); }
  });

  app.get('/api/tools', async (request, reply): Promise<ToolsResponse | ErrorResponse | undefined> => {
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

        const score = computeScore(storage, {
          dataDir,
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

  app.get('/api/projects', async (): Promise<ProjectsResponse> => {
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

  app.get('/api/sessions/:id', async (request, reply): Promise<SessionDetailResponse | ErrorResponse> => {
    const { id } = request.params as { id: string };
    if (!isInitialized(dataDir)) return reply.code(503).send({ error: 'Not initialized' });
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      const pq = getResult(storage, id);
      const correlations = (db.prepare('SELECT * FROM correlations WHERE session_id = ?').all(id) as Record<string, unknown>[]).map(c => {
        let reasons: string[] = [];
        if (c.metadata_json) {
          try {
            const parsed = JSON.parse(c.metadata_json as string) as { reasons?: unknown };
            if (Array.isArray(parsed.reasons)) reasons = parsed.reasons as string[];
          } catch { /* ignore malformed */ }
        }
        return {
          id: c.id as string,
          type: c.correlation_type as string,
          targetId: (c.target_id as string | null) ?? null,
          confidence: c.confidence as number,
          reasons,
        };
      });
      const outcomes = (db.prepare('SELECT * FROM outcomes WHERE session_id = ?').all(id) as Record<string, unknown>[]).map(o => ({
        id: o.id as string,
        type: o.outcome_type as string,
        label: o.label as string,
        score: (o.score as number | null) ?? null,
        note: (o.note as string | null) ?? null,
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
      const shipMap = deriveShipStatus(db, [id]);
      const shipStatus = shipMap.get(id) ?? null;
      const prCorrs = db.prepare(
        `SELECT target_id, metadata_json FROM correlations WHERE session_id = ? AND correlation_type = 'pr-outcome'`
      ).all(id) as { target_id: string; metadata_json: string | null }[];
      const prs = prCorrs.map(c => {
        const m = JSON.parse(c.metadata_json ?? '{}') as {
          prNumber: number; state: 'merged' | 'closed' | 'open'; title: string; url: string;
          mergedAt: string | null; closedAt: string | null; reverted: boolean;
        };
        return { prNumber: m.prNumber, state: m.state, title: m.title, url: m.url, mergedAt: m.mergedAt ?? null, closedAt: m.closedAt ?? null, reverted: m.reverted };
      });
      return {
        id: session.id as string,
        sourceToolId: session.source_tool_id as string,
        projectId: (session.project_id as string | null) ?? null,
        externalId: (session.external_id as string | null) ?? null,
        startedAt: (session.started_at as string | null) ?? null,
        endedAt: (session.ended_at as string | null) ?? null,
        durationMs: (session.duration_ms as number | null) ?? null,
        summary: (session.summary as string | null) ?? null,
        model: (session.model as string | null) ?? null,
        tokensInput: (session.tokens_input as number | null) ?? null,
        tokensOutput: (session.tokens_output as number | null) ?? null,
        costEstimate: (session.cost_estimate as number | null) ?? null,
        metadata: sessionMetadata, reworkCount,
        correlations, outcomes, uncorrelated: correlations.length === 0,
        promptQuality: pq
          ? {
              overall: pq.overall,
              signals: pq.signals,
              analyzerId: pq.analyzerId,
              analyzerVersion: pq.analyzerVersion,
              computedAt: pq.computedAt,
            }
          : undefined,
        shipStatus,
        prs,
      };
    } finally { storage.close(); }
  });

  app.get('/api/sessions/:id/diff', async (request, reply): Promise<SessionDiffResponse | ErrorResponse> => {
    const { id } = request.params as { id: string };
    const { repo, refresh } = request.query as { repo?: string; refresh?: string };
    if (!isInitialized(dataDir)) return reply.code(503).send({ error: 'Not initialized' });
    const storage = Storage.open({ dataDir });
    try {
      const session = storage.db
        .prepare('SELECT id, metadata_json FROM sessions WHERE id = ?')
        .get(id) as { id: string; metadata_json: string | null } | undefined;
      if (!session) return reply.code(404).send({ error: 'Session not found' });

      let repoPath = repo;
      if (!repoPath && session.metadata_json) {
        try {
          const parsed = JSON.parse(session.metadata_json) as { projectPath?: string };
          repoPath = parsed.projectPath;
        } catch { /* ignore */ }
      }
      if (!repoPath) {
        return reply.code(400).send({ error: 'Repo path required; pass ?repo=<path>' });
      }

      const commits = getSessionDiffs(storage.db, id, {
        repoPath,
        refresh: refresh === '1' || refresh === 'true',
      });
      return { commits };
    } finally { storage.close(); }
  });

  app.get('/api/prompt-quality', async (_request, reply): Promise<PromptQualityResponse | ErrorResponse> => {
    if (!isInitialized(dataDir)) return reply.code(503).send({ error: 'Not initialized' });
    const storage = Storage.open({ dataDir });
    try {
      const results = getAllResults(storage);
      const avg = results.length === 0 ? 0 : results.reduce((a, r) => a + r.overall, 0) / results.length;
      return {
        sessions: results,
        avgOverall: avg,
        analyzer: results[0]?.analyzerId ?? 'heuristic-v1',
      };
    } finally { storage.close(); }
  });

  app.post('/api/sessions/:id/annotations', async (request, reply): Promise<AnnotationCreateResponse | ErrorResponse> => {
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
      const note = body.note ? redactSecrets(body.note) : null;
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

  app.patch('/api/annotations/:id', async (request, reply): Promise<AnnotationPatchResponse | ErrorResponse> => {
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
      const note = body.note !== undefined
        ? (body.note ? redactSecrets(body.note) : null)
        : (existing.note as string | null);
      db.prepare('UPDATE outcomes SET label = ?, score = ?, note = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(outcome, score, note, id);
      return { id, sessionId: existing.session_id as string, outcome, score, note };
    } finally { storage.close(); }
  });

  app.get('/api/export/json', async (request, reply): Promise<JsonExportResponse | ErrorResponse | undefined> => {
    const q = request.query as Record<string, string>;
    if (!isInitialized(dataDir)) return { sessions: [], score: { aggregate: 0, dimensions: [], missingInputs: [], dataCompleteness: 0, evidenceLevel: 'insufficient' }, tools: [], totalSessions: 0, period: { from: null, to: null }, empty: true, generatedAt: new Date().toISOString() };
    const filters = parseFilterParams(q, reply);
    if (!filters) return;

    const storage = Storage.open({ dataDir });
    try {
      return generateJsonExport(storage, {
        toolId: filters.tool, projectId: filters.project,
        from: filters.from, to: filters.to, raw: filters.raw,
        dataDir,
      });
    } finally { storage.close(); }
  });

  app.get('/api/export/markdown', async (request, reply): Promise<string | ErrorResponse | undefined> => {
    const q = request.query as Record<string, string>;
    if (!isInitialized(dataDir)) return reply.type('text/markdown').send('# No Data\nNo sessions available.');
    const filters = parseFilterParams(q, reply);
    if (!filters) return;

    const storage = Storage.open({ dataDir });
    try {
      const md = generateMarkdownExport(storage, {
        toolId: filters.tool, projectId: filters.project,
        from: filters.from, to: filters.to, raw: filters.raw,
        dataDir,
      });
      return reply.type('text/markdown').send(md);
    } finally { storage.close(); }
  });
}
