import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createApiServer } from '../src/api/server.js';

function seedFixtures(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    INSERT OR IGNORE INTO projects (id, name) VALUES ('proj1', 'Project Alpha');
    INSERT OR IGNORE INTO tools (id, name, display_name) VALUES ('codex', 'codex', 'Codex');
    INSERT OR IGNORE INTO tools (id, name, display_name) VALUES ('claude-code', 'claude-code', 'Claude Code');
    INSERT INTO sessions (id, source_tool_id, project_id, external_id, started_at, ended_at, duration_ms, summary, model, tokens_input, tokens_output, cost_estimate, metadata_json)
    VALUES ('sess1', 'codex', 'proj1', 'ext-1', '2025-01-15T10:00:00Z', '2025-01-15T11:00:00Z', 3600000, 'Implemented auth module', 'gpt-4', 5000, 2000, 0.15, '{"reworkCount":1}'),
           ('sess2', 'claude-code', 'proj1', 'ext-2', '2025-01-16T14:00:00Z', '2025-01-16T15:30:00Z', 5400000, 'Fixed database migration', 'claude-3', 3000, 1500, 0.08, null),
           ('sess3', 'codex', 'proj1', 'ext-3', '2025-01-17T09:00:00Z', '2025-01-17T09:45:00Z', 2700000, 'Added unit tests', 'gpt-4', 2000, 1000, 0.05, null);
    INSERT INTO outcomes (id, session_id, outcome_type, score, label, note) VALUES ('out1', 'sess1', 'manual', 0.8, 'good', 'Auth shipped');
    INSERT INTO git_commits (id, hash, short_hash, message, author, authored_at, branch, project_id) VALUES ('gc1', 'abc123def456', 'abc123d', 'feat: add auth', 'dev', '2025-01-15T10:30:00Z', 'main', 'proj1');
    INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json) VALUES ('corr1', 'sess1', 'git-commit', 'gc1', 0.85, '{"reasons":["time overlap","same project"]}');
    INSERT INTO test_outcomes (id, project_id, session_id, commit_id, command, passed, failed, skipped, duration_ms, run_at) VALUES ('to1', 'proj1', 'sess1', 'gc1', 'npm test', 42, 0, 2, 15000, '2025-01-15T11:15:00Z');
  `);
  db.close();
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const cliPath = join(process.cwd(), 'bin', 'cli.js');
  try {
    const stdout = execFileSync('node', [cliPath, ...args], { encoding: 'utf-8', env: { ...process.env }, timeout: 15000 });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim(), exitCode: e.status ?? 1 };
  }
}

const PORT = 43199;

describe('API Server', () => {
  let tempDir: string;
  let dataDir: string;
  let server: Awaited<ReturnType<typeof createApiServer>> | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-api-test-'));
    dataDir = join(tempDir, 'tracker-data');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, 'exports'), { recursive: true });
    mkdirSync(join(dataDir, 'importers'), { recursive: true });
    mkdirSync(join(dataDir, 'correlations'), { recursive: true });
  });

  afterEach(async () => {
    if (server) { try { await server.close(); } catch { /* ignore */ } server = null; }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates server bound to 127.0.0.1 only', async () => {
    const { Storage } = await import('../src/storage.js');
    const s = Storage.open({ dataDir });
    s.close();
    server = await createApiServer({ dataDir, port: PORT });
    await server.listen();
    const addr = server.address();
    expect(addr).toBeTruthy();
    if (typeof addr === 'object' && addr) {
      expect(addr.address).toBe('127.0.0.1');
      expect(addr.port).toBe(PORT);
    }
    await server.close();
    server = null;
  });

  describe('GET /health', () => {
    it('returns ok status', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('ok');
    });
  });

  describe('GET /api/overview', () => {
    it('returns overview data with seeded sessions', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(3);
      expect(body.tools).toContain('codex');
      expect(body.tools).toContain('claude-code');
      expect(body.score).toBeDefined();
      expect(body.score.aggregate).toBeGreaterThanOrEqual(0);
      expect(body.outcomeCount).toBeGreaterThanOrEqual(1);
    });

    it('returns empty state with guidance when no sessions', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(0);
      expect(body.empty).toBe(true);
      expect(body.message).toBeDefined();
    });
  });

  describe('GET /api/timeline', () => {
    it('returns sessions in chronological order', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/timeline' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(3);
      const times = body.sessions.map((s: { startedAt: string }) => new Date(s.startedAt).getTime());
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
      }
    });

    it('filters by tool', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/timeline?tool=codex' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(2);
      expect(body.sessions.every((s: { sourceToolId: string }) => s.sourceToolId === 'codex')).toBe(true);
    });

    it('filters by date range', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/timeline?from=2025-01-16&to=2025-01-17' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(2);
    });
  });

  describe('GET /api/tools', () => {
    it('returns per-tool comparison data', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/tools' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.tools.length).toBe(2);
      const codex = body.tools.find((t: { toolId: string }) => t.toolId === 'codex');
      expect(codex).toBeDefined();
      expect(codex.sessionCount).toBe(2);
    });
  });

  describe('GET /api/sessions/:id', () => {
    it('returns session details with correlations and outcomes', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/sessions/sess1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe('sess1');
      expect(body.correlations.length).toBe(1);
      expect(body.correlations[0].type).toBe('git-commit');
      expect(body.outcomes.length).toBe(1);
    });

    it('returns empty correlations for uncorrelated session', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/sessions/sess2' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.correlations.length).toBe(0);
      expect(body.uncorrelated).toBe(true);
    });

    it('returns 404 for nonexistent session', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/sessions/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/sessions/:id/annotations', () => {
    it('creates annotation and returns it', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'POST', url: '/api/sessions/sess2/annotations',
        payload: { outcome: 'good', score: 0.9, note: 'Great work' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.sessionId).toBe('sess2');
      expect(body.outcome).toBe('good');
      expect(body.score).toBe(0.9);
    });

    it('rejects invalid annotation', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'POST', url: '/api/sessions/sess2/annotations',
        payload: { outcome: '' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects annotation for nonexistent session', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'POST', url: '/api/sessions/nonexistent/annotations',
        payload: { outcome: 'good' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/annotations/:id', () => {
    it('updates existing annotation', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.db.prepare("INSERT INTO outcomes (id, session_id, outcome_type, score, label, note, tags_json) VALUES ('ann1', 'sess2', 'manual', 0.5, 'ok', 'initial', null)").run();
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'PATCH', url: '/api/annotations/ann1',
        payload: { outcome: 'good', score: 0.9, note: 'Updated' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.outcome).toBe('good');
      expect(body.score).toBe(0.9);
    });
  });

  describe('Export endpoints', () => {
    it('exports JSON report matching current state', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/export/json' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(3);
      expect(body.score).toBeDefined();
      expect(body.tools).toBeDefined();
    });

    it('exports Markdown report', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/export/markdown' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/markdown');
      expect(res.payload).toContain('Effectiveness');
      expect(res.payload).toContain('Session');
    });

    it('exports empty state report', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/export/json' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(0);
      expect(body.empty).toBe(true);
    });

    it('respects filters in export', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/export/json?tool=claude-code' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(1);
      expect(body.sessions[0].sourceToolId).toBe('claude-code');
    });
  });

  describe('Cross-origin protection', () => {
    it('rejects POST with hostile Origin header', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'POST', url: '/api/sessions/sess2/annotations',
        payload: { outcome: 'good' },
        headers: { 'content-type': 'application/json', 'origin': 'https://evil.example.com' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows POST from localhost origin', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'POST', url: '/api/sessions/sess2/annotations',
        payload: { outcome: 'good' },
        headers: { 'content-type': 'application/json', 'origin': 'http://127.0.0.1:' + PORT },
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects cross-origin GET to /api/overview', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'GET', url: '/api/overview',
        headers: { 'origin': 'http://evil.example:80' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows same-origin GET to /api/overview', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'GET', url: '/api/overview',
        headers: { 'origin': 'http://127.0.0.1:' + PORT },
      });
      expect(res.statusCode).not.toBe(403);
    });

    it('allows no-origin GET (CLI / curl) to /api/overview', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview' });
      expect(res.statusCode).not.toBe(403);
    });

    it('rejects cross-origin GET to /api/sessions/:id/diff (side-effecting endpoint)', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'GET', url: '/api/sessions/sess1/diff?repo=/tmp',
        headers: { 'origin': 'http://evil.example:80' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Read-only by default', () => {
    it('unsupported methods return 400+', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'DELETE', url: '/api/overview' });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});

describe('CLI export command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-export-test-'));
    dataDir = join(tempDir, 'tracker-data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exports JSON to file', () => {
    runCli(['init', '-d', dataDir]);
    const outPath = join(tempDir, 'report.json');
    const result = runCli(['export', '-d', dataDir, '--format', 'json', '-o', outPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Exported');
    expect(existsSync(outPath)).toBe(true);
    const content = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(content).toBeDefined();
    expect(content.empty).toBe(true);
  });

  it('exports Markdown to file', () => {
    runCli(['init', '-d', dataDir]);
    const outPath = join(tempDir, 'report.md');
    const result = runCli(['export', '-d', dataDir, '--format', 'markdown', '-o', outPath]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).toContain('Effectiveness');
  });

  it('refuses overwrite without --overwrite flag', () => {
    runCli(['init', '-d', dataDir]);
    const outPath = join(tempDir, 'report.json');
    writeFileSync(outPath, 'existing content');
    const result = runCli(['export', '-d', dataDir, '--format', 'json', '-o', outPath]);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(outPath, 'utf-8')).toBe('existing content');
  });

  it('allows overwrite with --overwrite flag', () => {
    runCli(['init', '-d', dataDir]);
    const outPath = join(tempDir, 'report.json');
    writeFileSync(outPath, 'existing content');
    const result = runCli(['export', '-d', dataDir, '--format', 'json', '-o', outPath, '--overwrite']);
    expect(result.exitCode).toBe(0);
    const content = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(content).toBeDefined();
  });

  it('JSON export is valid JSON with expected fields', () => {
    runCli(['init', '-d', dataDir]);
    const outPath = join(tempDir, 'report.json');
    runCli(['export', '-d', dataDir, '--format', 'json', '-o', outPath]);
    const content = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(content.score).toBeDefined();
    expect(content.sessions).toBeDefined();
    expect(Array.isArray(content.sessions)).toBe(true);
  });
});

describe('CLI serve command', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-serve-test-'));
    dataDir = join(tempDir, 'tracker-data');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('shows help text with localhost URL', () => {
    runCli(['init', '-d', dataDir]);
    const result = runCli(['serve', '-d', dataDir, '-p', '43198', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('port');
  });
});



// =============================================================================
// Dashboard validation gap tests
// =============================================================================

describe('API validation gaps', () => {
  let tempDir: string;
  let dataDir: string;
  let server: Awaited<ReturnType<typeof createApiServer>> | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-valgap-'));
    dataDir = join(tempDir, 'tracker-data');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, 'exports'), { recursive: true });
    mkdirSync(join(dataDir, 'importers'), { recursive: true });
    mkdirSync(join(dataDir, 'correlations'), { recursive: true });
  });

  afterEach(async () => {
    if (server) { try { await server.close(); } catch { /* ignore */ } server = null; }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── /api/overview with filters ──────────────────────────────────────────

  describe('GET /api/overview with filters', () => {
    it('honors tool filter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?tool=codex' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(2); // sess1 and sess3 are codex
      expect(body.tools).toEqual(['codex']);
    });

    it('honors project filter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?project=proj1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(3);
    });

    it('honors from/to date filters', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?from=2025-01-16&to=2025-01-17' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(2); // sess2 and sess3
    });

    it('honors combined tool + date filters', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?tool=claude-code&from=2025-01-16' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(1); // sess2 only
      expect(body.tools).toEqual(['claude-code']);
    });

    // ── Filtered outcomeCount tests ──────────────────────────────────────

    it('outcomeCount counts all outcomes when no filters applied', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // Only sess1 has an outcome (out1), so global outcomeCount is 1
      expect(body.outcomeCount).toBe(1);
    });

    it('outcomeCount scopes to tool filter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      // codex has 2 sessions (sess1, sess3), only sess1 has an outcome
      const res = await server.inject({ method: 'GET', url: '/api/overview?tool=codex' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(2);
      expect(body.outcomeCount).toBe(1);
    });

    it('outcomeCount scopes to tool filter with no matching outcomes', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      // claude-code has 1 session (sess2) with no outcome
      const res = await server.inject({ method: 'GET', url: '/api/overview?tool=claude-code' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(1);
      expect(body.outcomeCount).toBe(0);
    });

    it('outcomeCount scopes to project filter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?project=proj1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(3);
      // Only sess1 (in proj1) has an outcome
      expect(body.outcomeCount).toBe(1);
    });

    it('outcomeCount scopes to date range filter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      // Only sess1 (2025-01-15) is in this range, and it has an outcome
      const res = await server.inject({ method: 'GET', url: '/api/overview?from=2025-01-15&to=2025-01-15' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(1);
      expect(body.outcomeCount).toBe(1);
    });

    it('outcomeCount scopes to date range filter that excludes outcome-carrying sessions', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      // sess2 and sess3 (2025-01-16, 2025-01-17) have no outcomes
      const res = await server.inject({ method: 'GET', url: '/api/overview?from=2025-01-16&to=2025-01-17' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(2);
      expect(body.outcomeCount).toBe(0);
    });

    it('outcomeCount scopes to combined tool and project filter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?tool=codex&project=proj1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(2);
      expect(body.outcomeCount).toBe(1);
    });

    it('outcomeCount is 0 when no sessions match filters', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?tool=nonexistent' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(0);
      expect(body.empty).toBe(true);
      // outcomeCount should be 0 when no sessions match
      expect(body.outcomeCount).toBe(0);
    });
  });

  // ── Malformed query parameters ──────────────────────────────────────────

  describe('Malformed query parameters return 4xx', () => {
    it('returns 400 for invalid from date format', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?from=not-a-date' });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('from');
    });

    it('returns 400 for invalid to date format', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?to=bad-date' });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('to');
    });

    it('returns 400 for excessively long tool parameter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/overview?tool=' + 'a'.repeat(201) });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('tool');
    });

    it('malformed date on timeline returns 400', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/timeline?from=invalid' });
      expect(res.statusCode).toBe(400);
    });

    it('malformed date on export/json returns 400', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/export/json?from=bad' });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Timeline with correlation/outcome highlights ────────────────────────

  describe('GET /api/timeline with highlights', () => {
    it('includes correlationCount and outcomeCount per session', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/timeline' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(3);
      // sess1 has correlation and outcome
      const sess1 = body.sessions.find((s: { id: string }) => s.id === 'sess1');
      expect(sess1).toBeDefined();
      expect(sess1.correlationCount).toBeGreaterThanOrEqual(1);
      expect(sess1.outcomeCount).toBeGreaterThanOrEqual(1);
      expect(sess1.hasOutcome).toBe(true);
      expect(sess1.outcomeLabels).toContain('good');
      expect(sess1.reworkCount).toBe(1); // sess1 has reworkCount:1 in metadata_json
      // sess2 has no correlations or outcomes
      const sess2 = body.sessions.find((s: { id: string }) => s.id === 'sess2');
      expect(sess2).toBeDefined();
      expect(sess2.correlationCount).toBe(0);
      expect(sess2.outcomeCount).toBe(0);
      expect(sess2.hasOutcome).toBe(false);
    });
  });

  // ── /api/projects endpoint ──────────────────────────────────────────────

  describe('GET /api/projects', () => {
    it('returns list of projects with session counts', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/projects' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.projects.length).toBe(1);
      expect(body.projects[0].projectId).toBe('proj1');
      expect(body.projects[0].sessionCount).toBe(3);
    });
  });

  // ── /api/tools with filters ────────────────────────────────────────────

  describe('GET /api/tools with filters', () => {
    it('honors tool filter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/tools?tool=codex' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.tools.length).toBe(1);
      expect(body.tools[0].toolId).toBe('codex');
      expect(body.tools[0].sessionCount).toBe(2);
    });

    it('honors date range filter and returns filtered tool data', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/tools?from=2025-01-16&to=2025-01-17' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.tools.length).toBe(2);
      const codex = body.tools.find((t: { toolId: string }) => t.toolId === 'codex');
      expect(codex).toBeDefined();
      expect(codex.sessionCount).toBe(1);
    });

    it('honors combined tool + date filters', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/tools?tool=codex&from=2025-01-16' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.tools.length).toBe(1);
      expect(body.tools[0].toolId).toBe('codex');
      expect(body.tools[0].sessionCount).toBe(1);
    });

    it('returns empty when no tools match filters', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/tools?tool=nonexistent' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.tools.length).toBe(0);
    });

    it('accepts project filter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/tools?project=proj1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.tools.length).toBe(2);
    });
  });

  // ── Raw export opt-in ───────────────────────────────────────────────────

  describe('Export raw opt-in (VAL-IMPORT-009, VAL-IMPORT-010)', () => {
    it('default export excludes raw metadata', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/export/json' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      const sess1 = body.sessions.find((s: { id: string }) => s.id === 'sess1');
      expect(sess1).toBeDefined();
      // Default export should NOT include raw metadata
      expect(sess1.metadata).toBeUndefined();
      // But should include reworkCount (safe aggregate indicator)
      expect(sess1.reworkCount).toBe(1);
    });

    it('?raw=true includes metadata', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/export/json?raw=true' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      const sess1 = body.sessions.find((s: { id: string }) => s.id === 'sess1');
      expect(sess1).toBeDefined();
      // With raw=true, metadata should be included
      expect(sess1.metadata).toBeDefined();
      expect(sess1.metadata.reworkCount).toBe(1);
    });
  });

  // ── PATCH annotation score range ────────────────────────────────────────

  describe('PATCH /api/annotations/:id (VAL-DASH-013)', () => {
    it('rejects score out of range and keeps existing annotation unchanged', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      // Insert an existing annotation
      s.db.prepare("INSERT INTO outcomes (id, session_id, outcome_type, score, label, note, tags_json) VALUES ('ann-keep', 'sess1', 'manual', 0.5, 'ok', 'original note', null)").run();
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      // Attempt PATCH with invalid score
      const res = await server.inject({
        method: 'PATCH', url: '/api/annotations/ann-keep',
        payload: { score: 1.5 },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Score');

      // Verify existing annotation is unchanged
      const { Storage: S } = await import('../src/storage.js');
      const s2 = S.open({ dataDir });
      try {
        const row = s2.db.prepare('SELECT * FROM outcomes WHERE id = ?').get('ann-keep') as { label: string; score: number; note: string };
        expect(row.label).toBe('ok');
        expect(row.score).toBe(0.5);
        expect(row.note).toBe('original note');
      } finally { s2.close(); }
    });

    it('rejects invalid outcome string and keeps existing annotation unchanged', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.db.prepare("INSERT INTO outcomes (id, session_id, outcome_type, score, label, note, tags_json) VALUES ('ann-keep2', 'sess2', 'manual', 0.3, 'neutral', 'note', null)").run();
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'PATCH', url: '/api/annotations/ann-keep2',
        payload: { outcome: 'completely-invalid-outcome' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(400);

      const { Storage: S } = await import('../src/storage.js');
      const s2 = S.open({ dataDir });
      try {
        const row = s2.db.prepare('SELECT * FROM outcomes WHERE id = ?').get('ann-keep2') as { label: string };
        expect(row.label).toBe('neutral');
      } finally { s2.close(); }
    });

    it('rejects empty string outcome', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.db.prepare("INSERT INTO outcomes (id, session_id, outcome_type, score, label, note, tags_json) VALUES ('ann-keep3', 'sess1', 'manual', 0.7, 'good', 'fine', null)").run();
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({
        method: 'PATCH', url: '/api/annotations/ann-keep3',
        payload: { outcome: '' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Session detail with rework count ────────────────────────────────────

  describe('GET /api/sessions/:id with rework indicators', () => {
    it('shows reworkCount from metadata', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/sessions/sess1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.reworkCount).toBe(1); // sess1 has reworkCount:1
    });

    it('shows 0 reworkCount when no metadata or no rework', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/sessions/sess2' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.reworkCount).toBe(0);
      expect(body.metadata).toBeNull();
    });
  });

  // ── Project filter on export APIs ───────────────────────────────────────

  describe('Project filter on export', () => {
    it('export/json respects project filter', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/export/json?project=proj1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(3);
      expect(body.sessions.every((s: { projectId: string }) => s.projectId === 'proj1')).toBe(true);
    });

    it('export/json with tool filter scopes correctly', async () => {
      const { Storage } = await import('../src/storage.js');
      const s = Storage.open({ dataDir });
      seedFixtures(s.dbPath);
      s.close();
      server = await createApiServer({ dataDir, port: PORT });
      const res = await server.inject({ method: 'GET', url: '/api/export/json?tool=claude-code' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.totalSessions).toBe(1);
      expect(body.sessions[0].sourceToolId).toBe('claude-code');
    });
  });
});
