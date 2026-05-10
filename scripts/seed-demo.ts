/**
 * Demo data seeder for README screenshots.
 *
 * Populates a scratch Storage under `docs/assets/.demo-data` with a realistic,
 * deterministic dataset: 24 sessions across ~4 weeks ending 2026-05-01, split
 * across claude-code/codex/opencode/cursor, plus git commits, test outcomes,
 * and manual annotations. Runs the correlation engine afterward so the
 * dashboard has populated correlation counts.
 *
 * Run: `tsx scripts/seed-demo.ts`
 *
 * The output directory is deleted and recreated on every run to keep the
 * seed deterministic. Data is scratch only — `.demo-data/` is gitignored.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureDataDir } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { deriveProjectId, deriveProjectName } from '../src/project-identity.js';
import { correlateSession } from '../src/correlation/engine.js';

interface SessionSeed {
  toolId: string;
  summary: string;
  startedAt: Date;
  durationMinutes: number;
  model: string | null;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  reworkCount?: number;
}

const DEMO_PROJECT_PATH = '/home/demo/acme-api';
const DATA_DIR = resolve(process.cwd(), 'docs', 'assets', '.demo-data');

const TOOLS: Array<{ id: string; name: string; displayName: string }> = [
  { id: 'claude-code', name: 'claude-code', displayName: 'Claude Code' },
  { id: 'codex', name: 'codex', displayName: 'Codex' },
  { id: 'opencode', name: 'opencode', displayName: 'OpenCode' },
  { id: 'cursor', name: 'cursor', displayName: 'Cursor' },
];

const SUMMARIES: Record<string, string[]> = {
  'claude-code': [
    'Refactor auth middleware to use JWT refresh tokens',
    'Add rate limit tests for the public API',
    'Debug flaky test in checkout flow',
    'Implement password reset email template',
    'Extract billing service from monolith',
    'Wire up feature flag for beta search',
    'Fix n+1 query in orders dashboard',
    'Port legacy validators to zod schemas',
    'Add retries for flaky webhook delivery',
    'Cache lookup for user permissions',
    'Rewrite session store to use Redis',
    'Optimize slow dashboard aggregation',
  ],
  codex: [
    'Generate TypeScript types from OpenAPI spec',
    'Scaffold admin users CRUD endpoints',
    'Write migration for invoices table',
    'Draft readme for internal SDK',
    'Stub pagination helpers for list endpoints',
    'Add structured logging to queue worker',
  ],
  opencode: [
    'Investigate memory leak in import worker',
    'Refactor error handling in CSV exporter',
    'Add health check route for k8s probe',
  ],
  cursor: [
    'Tweak form validation copy',
  ],
};

const BRANCHES = ['main', 'feat/auth', 'feat/search'] as const;
const OUTCOME_LABELS = ['shipped', 'merged', 'partial', 'reverted'] as const;

const COMMIT_MESSAGES = [
  'feat(auth): refresh token rotation',
  'test(api): add rate limit coverage',
  'fix(checkout): stabilize flaky snapshot',
  'feat(email): password reset template',
  'refactor(billing): extract service boundary',
  'feat(search): beta feature flag',
  'perf(orders): eliminate n+1 join',
  'refactor(validators): port to zod',
  'fix(webhooks): add retry with backoff',
  'perf(perms): cache lookup results',
  'refactor(sessions): switch to redis store',
  'perf(dashboard): cache aggregations',
  'chore(openapi): regen typescript types',
  'feat(admin): users crud endpoints',
  'db(migrations): invoices table',
  'docs(sdk): initial readme draft',
  'feat(api): pagination helpers',
  'chore(logging): structured logs in worker',
  'fix(workers): plug memory leak',
  'refactor(exporter): tidy error paths',
  'feat(health): k8s readiness probe',
  'fix(ui): form validation copy',
];

/**
 * Distribute 24 sessions across tools using a 50/30/15/5 split while staying
 * fully deterministic. Each tool gets its summary pool rotated through.
 */
function buildSessionSeeds(): SessionSeed[] {
  const allocations: Array<{ toolId: string; count: number }> = [
    { toolId: 'claude-code', count: 12 },
    { toolId: 'codex', count: 7 },
    { toolId: 'opencode', count: 4 },
    { toolId: 'cursor', count: 1 },
  ];

  const seeds: SessionSeed[] = [];
  const endDate = new Date('2026-05-01T17:00:00Z');
  const windowStartMs = endDate.getTime() - 28 * 24 * 60 * 60 * 1000;

  const models: Record<string, string | null> = {
    'claude-code': 'claude-sonnet-4-5',
    'codex': 'gpt-5-codex',
    'opencode': 'claude-sonnet-4-5',
    'cursor': 'gpt-4.1',
  };

  let idx = 0;
  for (const { toolId, count } of allocations) {
    const summaries = SUMMARIES[toolId] ?? ['AI coding session'];
    for (let i = 0; i < count; i++) {
      // Spread evenly across the 28-day window, with a predictable offset per tool
      // so sessions don't stack on a single day.
      const t = (idx + 0.5) / 24;
      const startedMs = windowStartMs + t * (endDate.getTime() - windowStartMs);
      const jitterMinutes = ((idx * 37) % 180) - 90; // ±90 minutes, deterministic
      const startedAt = new Date(startedMs + jitterMinutes * 60 * 1000);

      // Duration between 12 and 58 minutes
      const durationMinutes = 12 + ((idx * 17) % 47);

      const summary = summaries[i % summaries.length];

      // 80% of sessions get token/cost data
      const hasTokens = idx % 5 !== 0;
      const tokensIn = hasTokens ? 2400 + ((idx * 173) % 9600) : undefined;
      const tokensOut = hasTokens ? 1200 + ((idx * 91) % 4800) : undefined;
      const cost = hasTokens
        ? Math.round(((tokensIn! * 0.000003) + (tokensOut! * 0.000015)) * 1000) / 1000
        : undefined;

      seeds.push({
        toolId,
        summary,
        startedAt,
        durationMinutes,
        model: models[toolId] ?? null,
        tokensIn,
        tokensOut,
        cost,
      });

      idx++;
    }
  }

  // 2 sessions carry metadata.reworkCount > 0 so the rework dimension fires.
  seeds[3].reworkCount = 2;
  seeds[14].reworkCount = 1;

  return seeds;
}

function toSqliteTimestamp(d: Date): string {
  // SQLite-friendly ISO format without ms: 'YYYY-MM-DDTHH:MM:SS.sssZ' is acceptable,
  // but the rest of the codebase uses full ISO strings, so match that.
  return d.toISOString();
}

function shortHash(idx: number): string {
  // Deterministic 8-char hex using a simple hash of the index.
  const h = ((idx + 1) * 2654435761 >>> 0).toString(16).padStart(8, '0');
  return h.slice(0, 8);
}

async function main(): Promise<void> {
  // Fresh slate every run.
  try {
    rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch {
    // best-effort on Windows
  }
  mkdirSync(DATA_DIR, { recursive: true });
  ensureDataDir(DATA_DIR);

  // Leave default scoring weights in place. Writing an explicit file documents
  // intent and keeps the data dir self-contained.
  writeFileSync(
    join(DATA_DIR, 'scoring.json'),
    JSON.stringify({ weights: {}, thresholds: {} }, null, 2) + '\n',
    'utf-8',
  );

  const storage = Storage.open({ dataDir: DATA_DIR });
  try {
    const db = storage.db;

    // 1. Seed tools
    const insertTool = db.prepare(
      'INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)',
    );
    const toolTx = db.transaction(() => {
      for (const t of TOOLS) insertTool.run(t.id, t.name, t.displayName);
    });
    toolTx();

    // 2. Seed project
    const projectId = deriveProjectId(DEMO_PROJECT_PATH);
    const projectName = deriveProjectName(DEMO_PROJECT_PATH);
    db.prepare(
      'INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)',
    ).run(projectId, projectName, DEMO_PROJECT_PATH);

    // 3. Seed sessions
    const seeds = buildSessionSeeds();
    const sessionIds: string[] = [];

    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, source_tool_id, project_id, external_id,
        started_at, ended_at, duration_ms,
        summary, model,
        tokens_input, tokens_output, cost_estimate,
        metadata_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const sessionTx = db.transaction(() => {
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        const id = randomUUID();
        sessionIds.push(id);

        const endedAt = new Date(s.startedAt.getTime() + s.durationMinutes * 60 * 1000);
        const durationMs = s.durationMinutes * 60 * 1000;
        const externalId = `${s.toolId}-demo-${String(i + 1).padStart(3, '0')}`;

        const metadata: Record<string, unknown> = {};
        if (s.reworkCount && s.reworkCount > 0) metadata.reworkCount = s.reworkCount;
        const metadataJson = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;

        insertSession.run(
          id,
          s.toolId,
          projectId,
          externalId,
          toSqliteTimestamp(s.startedAt),
          toSqliteTimestamp(endedAt),
          durationMs,
          s.summary,
          s.model,
          s.tokensIn ?? null,
          s.tokensOut ?? null,
          s.cost ?? null,
          metadataJson,
        );
      }
    });
    sessionTx();

    // 4. Seed 22 git commits linked to ~70% of sessions (16 unique sessions covered).
    const COMMIT_COUNT = 22;
    const LINKED_SESSION_COUNT = Math.round(seeds.length * 0.7); // 17
    const insertCommit = db.prepare(`
      INSERT INTO git_commits (
        id, hash, short_hash, message, author, authored_at, branch, project_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const commitTx = db.transaction(() => {
      for (let i = 0; i < COMMIT_COUNT; i++) {
        const linkedIdx = i % LINKED_SESSION_COUNT;
        const session = seeds[linkedIdx];
        // Commit lands near the end of the linked session (within its window).
        const authoredOffsetMinutes = (session.durationMinutes * 0.6) + (i % 7) * 2;
        const authoredAt = new Date(
          session.startedAt.getTime() + authoredOffsetMinutes * 60 * 1000,
        );

        const short = shortHash(i);
        // Full hash: repeat short hash pattern to form a 40-char hex string.
        const full = (short.repeat(5)).slice(0, 40);
        const message = COMMIT_MESSAGES[i % COMMIT_MESSAGES.length];
        const branch = BRANCHES[i % BRANCHES.length];

        insertCommit.run(
          randomUUID(),
          full,
          short,
          message,
          'Demo User <demo@example.com>',
          toSqliteTimestamp(authoredAt),
          branch,
          projectId,
        );
      }
    });
    commitTx();

    // 5. Seed 6 test outcomes: 4 pass-only, 2 with failures. Spread across window.
    const insertTestOutcome = db.prepare(`
      INSERT INTO test_outcomes (
        id, project_id, session_id, commit_id, command,
        passed, failed, skipped, duration_ms, raw_output_summary, run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const testOutcomeSeeds = [
      { sessionIdx: 1, passed: 12, failed: 0, skipped: 0, command: 'npm test' },
      { sessionIdx: 6, passed: 12, failed: 0, skipped: 1, command: 'npm test' },
      { sessionIdx: 10, passed: 12, failed: 0, skipped: 0, command: 'npm test' },
      { sessionIdx: 15, passed: 12, failed: 0, skipped: 0, command: 'npm test' },
      { sessionIdx: 4, passed: 8, failed: 2, skipped: 0, command: 'npm test' },
      { sessionIdx: 18, passed: 8, failed: 2, skipped: 0, command: 'npm test' },
    ];

    const testTx = db.transaction(() => {
      for (const t of testOutcomeSeeds) {
        const seed = seeds[t.sessionIdx];
        const sessionEnd = new Date(seed.startedAt.getTime() + seed.durationMinutes * 60 * 1000);
        // Run tests 5 minutes after session end — inside the 1-hour window.
        const runAt = new Date(sessionEnd.getTime() + 5 * 60 * 1000);
        const durationMs = (t.passed + t.failed + t.skipped) * 250;
        const summary = t.failed === 0
          ? `${t.passed} tests passed, ${t.skipped} skipped`
          : `${t.passed} passed, ${t.failed} failed`;

        insertTestOutcome.run(
          randomUUID(),
          projectId,
          sessionIds[t.sessionIdx],
          null,
          t.command,
          t.passed,
          t.failed,
          t.skipped,
          durationMs,
          summary,
          toSqliteTimestamp(runAt),
        );
      }
    });
    testTx();

    // 6. Seed 8 manual outcome annotations with varied labels + scores.
    const insertOutcome = db.prepare(`
      INSERT INTO outcomes (
        id, session_id, outcome_type, score, label, note, tags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const outcomeSeeds = [
      { sessionIdx: 0, label: 'shipped', score: 0.9, note: 'Deployed to prod.' },
      { sessionIdx: 2, label: 'merged', score: 0.8, note: 'Approved, merged.' },
      { sessionIdx: 5, label: 'shipped', score: 0.95, note: 'Clean rollout.' },
      { sessionIdx: 7, label: 'merged', score: 0.75, note: 'Needed minor tweaks.' },
      { sessionIdx: 9, label: 'partial', score: 0.5, note: 'Landed behind a flag.' },
      { sessionIdx: 12, label: 'merged', score: 0.85, note: null },
      { sessionIdx: 17, label: 'reverted', score: 0.3, note: 'Broke a legacy consumer.' },
      { sessionIdx: 20, label: 'shipped', score: 0.8, note: null },
    ];

    const outcomeTx = db.transaction(() => {
      for (const o of outcomeSeeds) {
        insertOutcome.run(
          randomUUID(),
          sessionIds[o.sessionIdx],
          'manual',
          o.score,
          o.label,
          o.note,
          JSON.stringify(OUTCOME_LABELS.includes(o.label as typeof OUTCOME_LABELS[number])
            ? ['demo']
            : []),
        );
      }
    });
    outcomeTx();

    // 7. Run correlation so the correlations table has realistic content.
    for (const sid of sessionIds) {
      correlateSession(storage, sid);
    }

    const commitCount = (db.prepare('SELECT count(*) as n FROM git_commits').get() as { n: number }).n;
    const testCount = (db.prepare('SELECT count(*) as n FROM test_outcomes').get() as { n: number }).n;

    console.log(
      `Seeded ${sessionIds.length} sessions, ${commitCount} commits, ${testCount} test outcomes into ${DATA_DIR}`,
    );
  } finally {
    storage.close();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error('Seed failed:', msg);
  process.exit(1);
});
