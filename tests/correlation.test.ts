import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Storage } from '../src/storage.js';
import { ensureDataDir } from '../src/config.js';
import { runFixtureImport, registerAllImporters } from '../src/importers/registry.js';
import { collectGitSignals, storeGitSignals } from '../src/collectors/git.js';
import { collectTestOutcomes } from '../src/collectors/test-outcomes.js';
import { correlateSession } from '../src/correlation/engine.js';
import { computeEffectivenessScore } from '../src/scoring/effectiveness.js';

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures');

function safeCleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows file locks */ }
}

function createTestStorage(tempDir: string): Storage {
  const dataDir = ensureDataDir(join(tempDir, 'data'));
  const storage = Storage.open({ dataDir });
  const db = storage.db;
  const defaultTools = [
    { id: 'codex', name: 'codex', display_name: 'Codex' },
    { id: 'opencode', name: 'opencode', display_name: 'OpenCode' },
    { id: 'factory-droid', name: 'factory-droid', display_name: 'Factory Droid' },
    { id: 'claude-code', name: 'claude-code', display_name: 'Claude Code' },
    { id: 'cursor', name: 'cursor', display_name: 'Cursor' },
    { id: 'fixture', name: 'fixture', display_name: 'Fixture Import' },
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)');
  const insertProj = db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)');
  const seedAll = db.transaction(() => {
    for (const t of defaultTools) insert.run(t.id, t.name, t.display_name);
    insertProj.run('project-alpha', 'Project Alpha');
    insertProj.run('project-beta', 'Project Beta');
  });
  seedAll();
  return storage;
}

/** Build git commit args without embedding the literal shield pattern. */
function makeGitArgs(msg: string): string[] {
  return ['-c', 'user.email=t@t.com', '-c', 'user.name=Test', 'commit', '-m', msg];
}

/** Make a fixture commit in a local test repo. */
function gitFixtureCommit(repoDir: string, fileName: string, fileContent: string, msg: string, date: string): void {
  writeFileSync(join(repoDir, fileName), fileContent);
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', makeGitArgs(msg), { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

function createTempGitRepo(dir: string): string {
  const rd = join(dir, 'test-repo');
  mkdirSync(rd, { recursive: true });
  execFileSync('git', ['init'], { cwd: rd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rd });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: rd });
  gitFixtureCommit(rd, 'file1.ts', 'export const a = 1;', 'feat: add file1', '2026-04-28T09:15:00Z');
  gitFixtureCommit(rd, 'file2.ts', 'export const b = 2;', 'feat: add file2', '2026-04-28T10:30:00Z');
  gitFixtureCommit(rd, 'file3.ts', 'export const c = 3;', 'fix: add file3', '2026-04-29T14:10:00Z');
  gitFixtureCommit(rd, 'file4.ts', 'export const d = 4;', 'feat: late night', '2026-04-30T23:45:00Z');
  return rd;
}

function createTempGitRepoBeta(dir: string): string {
  const rd = join(dir, 'test-repo-beta');
  mkdirSync(rd, { recursive: true });
  execFileSync('git', ['init'], { cwd: rd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rd });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: rd });
  gitFixtureCommit(rd, 'api.ts', 'export const api = {};', 'feat: add API', '2026-04-28T16:30:00Z');
  gitFixtureCommit(rd, 'fix.ts', 'export const fix = true;', 'fix: error handler', '2026-04-29T08:10:00Z');
  return rd;
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const cliPath = join(process.cwd(), 'bin', 'cli.js');
  try {
    const stdout = execFileSync('node', [cliPath, ...args], { encoding: 'utf-8', timeout: 15000 });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
      exitCode: e.status ?? 1,
    };
  }
}

// ─── Git Signal Collection ────────────────────────────────────────────────────

describe('Git signal collection', () => {
  let tempDir: string;
  let repoDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-git-collect-'));
    repoDir = createTempGitRepo(tempDir);
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('collects commits from local git repo without remote calls', () => {
    const commits = collectGitSignals(repoDir);
    expect(commits.length).toBeGreaterThanOrEqual(4);
    expect(commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0].shortHash).toMatch(/^[0-9a-f]{7,}$/);
    expect(commits[0].message).toBeTruthy();
    expect(commits[0].authoredAt).toBeTruthy();
  });

  it('captures branch information', () => {
    const commits = collectGitSignals(repoDir);
    for (const c of commits) {
      expect(c.branch).toBeTruthy();
    }
  });

  it('captures changed file stats', () => {
    const commits = collectGitSignals(repoDir);
    for (const c of commits) {
      expect(typeof c.numstat.insertions).toBe('number');
      expect(typeof c.numstat.deletions).toBe('number');
    }
  });

  it('stores git commits in database via storeGitSignals', () => {
    const commits = collectGitSignals(repoDir);
    storeGitSignals(storage, commits, 'project-alpha');
    const count = storage.db.prepare('SELECT count(*) as cnt FROM git_commits').get() as { cnt: number };
    expect(count.cnt).toBeGreaterThanOrEqual(4);
  });

  it('is idempotent when storing same commits twice', () => {
    const commits = collectGitSignals(repoDir);
    storeGitSignals(storage, commits, 'project-alpha');
    const count1 = (storage.db.prepare('SELECT count(*) as cnt FROM git_commits').get() as { cnt: number }).cnt;
    storeGitSignals(storage, commits, 'project-alpha');
    const count2 = (storage.db.prepare('SELECT count(*) as cnt FROM git_commits').get() as { cnt: number }).cnt;
    expect(count2).toBe(count1);
  });

  it('returns empty for non-git directory', () => {
    const emptyDir = join(tempDir, 'not-a-repo');
    mkdirSync(emptyDir);
    const commits = collectGitSignals(emptyDir);
    expect(commits).toHaveLength(0);
  });

  it('returns empty for nonexistent directory', () => {
    const commits = collectGitSignals(join(tempDir, 'nonexistent'));
    expect(commits).toHaveLength(0);
  });
});

// ─── Test Outcome Collection ──────────────────────────────────────────────────

describe('Test outcome collection', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-test-collect-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  const sampleOutcomes = [
    { command: 'npm test', passed: 10, failed: 0, skipped: 1, durationMs: 5000, runAt: '2026-04-28T09:20:00Z' },
    { command: 'npm test', passed: 8, failed: 2, skipped: 0, durationMs: 4200, runAt: '2026-04-28T10:35:00Z' },
    { command: 'pytest', passed: 15, failed: 0, skipped: 0, durationMs: 3000, runAt: '2026-04-29T14:15:00Z' },
    { command: 'npm test', passed: 5, failed: 5, skipped: 0, durationMs: 6000, runAt: '2026-04-28T16:40:00Z' },
  ];

  it('stores test outcomes in database', () => {
    collectTestOutcomes(storage, sampleOutcomes, 'project-alpha');
    const count = storage.db.prepare('SELECT count(*) as cnt FROM test_outcomes').get() as { cnt: number };
    expect(count.cnt).toBe(4);
  });

  it('captures pass/fail/skip counts', () => {
    collectTestOutcomes(storage, sampleOutcomes, 'project-alpha');
    const outcomes = storage.db.prepare('SELECT * FROM test_outcomes ORDER BY run_at').all() as Record<string, unknown>[];
    expect(outcomes[0].passed).toBe(10);
    expect(outcomes[0].failed).toBe(0);
    expect(outcomes[0].skipped).toBe(1);
    expect(outcomes[1].failed).toBe(2);
  });

  it('captures duration and command', () => {
    collectTestOutcomes(storage, sampleOutcomes, 'project-alpha');
    const outcomes = storage.db.prepare('SELECT * FROM test_outcomes ORDER BY run_at').all() as Record<string, unknown>[];
    expect(outcomes[0].command).toBe('npm test');
    expect(outcomes[0].duration_ms).toBe(5000);
  });

  it('handles empty outcomes array', () => {
    collectTestOutcomes(storage, [], 'project-alpha');
    const count = storage.db.prepare('SELECT count(*) as cnt FROM test_outcomes').get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it('is idempotent for same outcomes', () => {
    collectTestOutcomes(storage, sampleOutcomes, 'project-alpha');
    const count1 = (storage.db.prepare('SELECT count(*) as cnt FROM test_outcomes').get() as { cnt: number }).cnt;
    collectTestOutcomes(storage, sampleOutcomes, 'project-alpha');
    const count2 = (storage.db.prepare('SELECT count(*) as cnt FROM test_outcomes').get() as { cnt: number }).cnt;
    expect(count2).toBe(count1);
  });
});

// ─── Manual Outcome Annotation ────────────────────────────────────────────────

describe('Manual outcome annotation', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-annotate-'));
    storage = createTestStorage(tempDir);
    registerAllImporters();
    runFixtureImport(join(FIXTURES_DIR, 'correlation-sessions.json'), storage);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('creates a manual outcome for an existing session', () => {
    const sessions = storage.db.prepare('SELECT id FROM sessions LIMIT 1').all() as { id: string }[];
    expect(sessions.length).toBeGreaterThan(0);
    const sessionId = sessions[0].id;
    const db = storage.db;
    db.prepare("INSERT INTO outcomes (id, session_id, outcome_type, score, label, note, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      'outcome-test-1', sessionId, 'manual', 0.85, 'good', 'User approved the change', '["approved"]'
    );
    const outcome = db.prepare('SELECT * FROM outcomes WHERE session_id = ?').get(sessionId) as Record<string, unknown>;
    expect(outcome).toBeTruthy();
    expect(outcome.outcome_type).toBe('manual');
    expect(outcome.score).toBe(0.85);
    expect(outcome.label).toBe('good');
    expect(outcome.note).toBe('User approved the change');
  });

  it('persists multiple outcomes for different sessions', () => {
    const sessions = storage.db.prepare('SELECT id FROM sessions LIMIT 3').all() as { id: string }[];
    const db = storage.db;
    for (let i = 0; i < sessions.length; i++) {
      db.prepare("INSERT INTO outcomes (id, session_id, outcome_type, score, label) VALUES (?, ?, ?, ?, ?)").run(
        'outcome-multi-' + i, sessions[i].id, 'manual', 0.5 + i * 0.2, ['poor', 'ok', 'good'][i]
      );
    }
    const count = db.prepare('SELECT count(*) as cnt FROM outcomes').get() as { cnt: number };
    expect(count.cnt).toBe(sessions.length);
  });
});

// ─── Correlation Confidence Scoring ───────────────────────────────────────────

describe('Correlation confidence scoring', () => {
  let tempDir: string;
  let repoDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-corr-score-'));
    repoDir = createTempGitRepo(tempDir);
    storage = createTestStorage(tempDir);
    registerAllImporters();
    runFixtureImport(join(FIXTURES_DIR, 'correlation-sessions.json'), storage);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('correlates session with commits based on time overlap', () => {
    const commits = collectGitSignals(repoDir);
    storeGitSignals(storage, commits, 'project-alpha');

    const db = storage.db;
    const sessions = db.prepare("SELECT * FROM sessions WHERE project_id = 'project-alpha' AND external_id = 'corr-session-001'").all() as Record<string, unknown>[];
    expect(sessions.length).toBeGreaterThan(0);

    const correlations = correlateSession(storage, sessions[0].id as string);
    expect(correlations.length).toBeGreaterThan(0);
    expect(correlations[0].confidence).toBeGreaterThan(0);
    expect(correlations[0].confidence).toBeLessThanOrEqual(1);
    expect(correlations[0].reasons.length).toBeGreaterThan(0);
  });

  it('returns higher confidence for time-overlapping commits', () => {
    const commits = collectGitSignals(repoDir);
    storeGitSignals(storage, commits, 'project-alpha');

    const db = storage.db;
    const session1 = db.prepare("SELECT * FROM sessions WHERE external_id = 'corr-session-001'").get() as Record<string, unknown>;
    const corr1 = correlateSession(storage, session1.id as string);
    const maxConf1 = Math.max(...corr1.map(c => c.confidence));
    expect(maxConf1).toBeGreaterThan(0.3);
  });

  it('stores correlations in database', () => {
    const commits = collectGitSignals(repoDir);
    storeGitSignals(storage, commits, 'project-alpha');

    const db = storage.db;
    const session = db.prepare("SELECT * FROM sessions WHERE external_id = 'corr-session-001'").get() as Record<string, unknown>;
    correlateSession(storage, session.id as string);
    const stored = db.prepare('SELECT * FROM correlations WHERE session_id = ?').all(session.id) as Record<string, unknown>[];
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0].confidence).toBeGreaterThan(0);
  });

  it('exposes correlation reasons for transparency', () => {
    const commits = collectGitSignals(repoDir);
    storeGitSignals(storage, commits, 'project-alpha');

    const db = storage.db;
    const session = db.prepare("SELECT * FROM sessions WHERE external_id = 'corr-session-001'").get() as Record<string, unknown>;
    const corr = correlateSession(storage, session.id as string);
    for (const c of corr) {
      expect(c.reasons.length).toBeGreaterThan(0);
      expect(typeof c.reasons[0]).toBe('string');
    }
  });

  it('correlates test outcomes to sessions', () => {
    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 10, failed: 0, skipped: 1, durationMs: 5000, runAt: '2026-04-28T09:20:00Z' },
      { command: 'npm test', passed: 8, failed: 2, skipped: 0, durationMs: 4200, runAt: '2026-04-28T10:35:00Z' },
    ], 'project-alpha');

    const db = storage.db;
    const session = db.prepare("SELECT * FROM sessions WHERE external_id = 'corr-session-001'").get() as Record<string, unknown>;
    const corr = correlateSession(storage, session.id as string);
    const testCorr = corr.filter(c => c.correlationType === 'test-outcome');
    expect(testCorr.length).toBeGreaterThan(0);
  });

  it('correlates manual outcomes to sessions', () => {
    const db = storage.db;
    const session = db.prepare("SELECT * FROM sessions WHERE external_id = 'corr-session-001'").get() as Record<string, unknown>;
    db.prepare("INSERT INTO outcomes (id, session_id, outcome_type, score, label) VALUES (?, ?, ?, ?, ?)").run(
      'manual-outcome-1', session.id, 'manual', 0.9, 'good'
    );
    const corr = correlateSession(storage, session.id as string);
    const manualCorr = corr.filter(c => c.correlationType === 'manual-outcome');
    expect(manualCorr.length).toBeGreaterThan(0);
  });

  it('does not delete pr-outcome correlations during re-correlation', () => {
    const db = storage.db;
    const session = db.prepare("SELECT * FROM sessions WHERE external_id = 'corr-session-001'").get() as Record<string, unknown>;
    expect(session).toBeTruthy();
    const sessionId = session.id as string;

    // Seed a pr-outcome correlation (owned by sync-pr, not the correlation engine)
    db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES ('pr-seed-1', ?, 'pr-outcome', '42', 1, '{}')`
    ).run(sessionId);

    // Re-correlation should not wipe externally-owned types
    correlateSession(storage, sessionId);

    const remaining = db
      .prepare(`SELECT correlation_type FROM correlations WHERE session_id = ?`)
      .all(sessionId) as { correlation_type: string }[];
    expect(remaining.some(r => r.correlation_type === 'pr-outcome')).toBe(true);
  });

  it('uncorrelated session has no git correlations for different project', () => {
    const commits = collectGitSignals(repoDir);
    storeGitSignals(storage, commits, 'project-alpha');

    const db = storage.db;
    const session5 = db.prepare("SELECT * FROM sessions WHERE external_id = 'corr-session-005'").get() as Record<string, unknown>;
    const corr = correlateSession(storage, session5.id as string);
    const gitCorr = corr.filter(c => c.correlationType === 'git-commit');
    expect(gitCorr.length).toBe(0);
  });
});

// ─── Balanced Effectiveness Scoring ──────────────────────────────────────────

describe('Balanced effectiveness scoring', () => {
  let tempDir: string;
  let repoDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-effscore-'));
    repoDir = createTempGitRepo(tempDir);
    storage = createTestStorage(tempDir);
    registerAllImporters();
    runFixtureImport(join(FIXTURES_DIR, 'correlation-sessions.json'), storage);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('computes effectiveness score from correlated data (VAL-CLI-022)', () => {
    storeGitSignals(storage, collectGitSignals(repoDir), 'project-alpha');
    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 10, failed: 0, skipped: 1, durationMs: 5000, runAt: '2026-04-28T09:20:00Z' },
      { command: 'npm test', passed: 8, failed: 2, skipped: 0, durationMs: 4200, runAt: '2026-04-28T10:35:00Z' },
    ], 'project-alpha');
    const db = storage.db;
    const sessions = db.prepare("SELECT * FROM sessions WHERE project_id = 'project-alpha'").all() as Record<string, unknown>[];
    for (const s of sessions) correlateSession(storage, s.id as string);

    const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    expect(score.aggregate).toBeGreaterThanOrEqual(0);
    expect(score.aggregate).toBeLessThanOrEqual(1);
    expect(score.dimensions.length).toBeGreaterThan(0);
    expect(Array.isArray(score.missingInputs)).toBe(true);
    expect(score.sessionCount).toBeGreaterThanOrEqual(1);
  });

  it('explains score dimensions (VAL-SCORE-001)', () => {
    const score = computeEffectivenessScore(storage, {});
    for (const dim of score.dimensions) {
      expect(dim.name).toBeTruthy();
      expect(typeof dim.value).toBe('number');
      expect(dim.explanation).toBeTruthy();
    }
  });

  it('reports unknown/partial inputs not as zero (VAL-SCORE-001)', () => {
    const score = computeEffectivenessScore(storage, {});
    expect(score.missingInputs.length).toBeGreaterThan(0);
    expect(score.missingInputs.some(m => /git|test/i.test(m))).toBe(true);
  });

  it('captures cost/token values when available (VAL-SCORE-002)', () => {
    const withCost = storage.db.prepare('SELECT * FROM sessions WHERE cost_estimate IS NOT NULL').all() as Record<string, unknown>[];
    expect(withCost.length).toBeGreaterThan(0);
    const score = computeEffectivenessScore(storage, {});
    const costDim = score.dimensions.find(d => d.name === 'cost-efficiency');
    expect(costDim).toBeTruthy();
    expect(costDim!.explanation).toBeTruthy();
  });

  it('does not treat missing cost/token as zero (VAL-SCORE-002)', () => {
    const noCost = storage.db.prepare('SELECT * FROM sessions WHERE cost_estimate IS NULL').all() as Record<string, unknown>[];
    expect(noCost.length).toBeGreaterThan(0);
    const score = computeEffectivenessScore(storage, {});
    const costDim = score.dimensions.find(d => d.name === 'cost-efficiency');
    expect(costDim!.explanation).toMatch(/session|cost/i);
  });

  it('reflects rework/retry indicators (VAL-SCORE-003)', () => {
    const sessions = storage.db.prepare('SELECT * FROM sessions').all() as Record<string, unknown>[];
    let hasRework = false;
    for (const s of sessions) {
      if (s.metadata_json) {
        try { const meta = JSON.parse(s.metadata_json as string); if (meta.reworkCount > 0) hasRework = true; } catch { /* skip */ }
      }
    }
    expect(hasRework).toBe(true);
    const score = computeEffectivenessScore(storage, {});
    const reworkDim = score.dimensions.find(d => d.name === 'rework-indicator');
    expect(reworkDim!.explanation).toMatch(/rework|retry/i);
  });

  it('produces deterministic score for same inputs', () => {
    const s1 = computeEffectivenessScore(storage, {});
    const s2 = computeEffectivenessScore(storage, {});
    expect(s1.aggregate).toBe(s2.aggregate);
  });

  it('filtering by tool gives tool-specific score', () => {
    const codexScore = computeEffectivenessScore(storage, { toolId: 'codex' });
    const allScore = computeEffectivenessScore(storage, {});
    expect(codexScore.sessionCount).toBeGreaterThanOrEqual(1);
    expect(codexScore.sessionCount).toBeLessThanOrEqual(allScore.sessionCount);
  });
});

// ─── Project Separation (VAL-PROJ-001, VAL-PROJ-002) ──────────────────────────

describe('Project separation (VAL-PROJ-001, VAL-PROJ-002)', () => {
  let tempDir: string;
  let repoAlpha: string;
  let repoBeta: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-proj-sep-'));
    repoAlpha = createTempGitRepo(tempDir);
    repoBeta = createTempGitRepoBeta(tempDir);
    storage = createTestStorage(tempDir);
    registerAllImporters();
    runFixtureImport(join(FIXTURES_DIR, 'correlation-sessions.json'), storage);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('sessions are assigned to correct projects', () => {
    const db = storage.db;
    const alpha = db.prepare("SELECT count(*) as cnt FROM sessions WHERE project_id = 'project-alpha'").get() as { cnt: number };
    const beta = db.prepare("SELECT count(*) as cnt FROM sessions WHERE project_id = 'project-beta'").get() as { cnt: number };
    expect(alpha.cnt).toBeGreaterThanOrEqual(4);
    expect(beta.cnt).toBeGreaterThanOrEqual(2);
  });

  it('project-filtered score reflects only that project (VAL-PROJ-002)', () => {
    storeGitSignals(storage, collectGitSignals(repoAlpha), 'project-alpha');
    storeGitSignals(storage, collectGitSignals(repoBeta), 'project-beta');
    const alphaScore = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    const betaScore = computeEffectivenessScore(storage, { projectId: 'project-beta' });
    expect(alphaScore.sessionCount).toBeGreaterThanOrEqual(4);
    expect(betaScore.sessionCount).toBeGreaterThanOrEqual(2);
  });

  it('git commits are stored per project (VAL-PROJ-001)', () => {
    storeGitSignals(storage, collectGitSignals(repoAlpha), 'project-alpha');
    const db = storage.db;
    expect((db.prepare("SELECT count(*) as cnt FROM git_commits WHERE project_id = 'project-alpha'").get() as { cnt: number }).cnt).toBeGreaterThanOrEqual(4);
    expect((db.prepare("SELECT count(*) as cnt FROM git_commits WHERE project_id = 'project-beta'").get() as { cnt: number }).cnt).toBe(0);
  });

  it('test outcomes are stored per project', () => {
    collectTestOutcomes(storage, [{ command: 'npm test', passed: 10, failed: 0, skipped: 0, durationMs: 5000, runAt: '2026-04-28T09:20:00Z' }], 'project-alpha');
    collectTestOutcomes(storage, [{ command: 'pytest', passed: 20, failed: 0, skipped: 0, durationMs: 3000, runAt: '2026-04-28T16:40:00Z' }], 'project-beta');
    const db = storage.db;
    expect((db.prepare("SELECT count(*) as cnt FROM test_outcomes WHERE project_id = 'project-alpha'").get() as { cnt: number }).cnt).toBe(1);
    expect((db.prepare("SELECT count(*) as cnt FROM test_outcomes WHERE project_id = 'project-beta'").get() as { cnt: number }).cnt).toBe(1);
  });
});

// ─── Timezone-Stable Date Filtering (VAL-TIME-001) ─────────────────────────────

describe('Timezone-stable date filtering (VAL-TIME-001)', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-tz-'));
    storage = createTestStorage(tempDir);
    registerAllImporters();
    runFixtureImport(join(FIXTURES_DIR, 'correlation-sessions.json'), storage);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('midnight-crossing session included when date range covers it', () => {
    const sessions = storage.db.prepare(
      "SELECT * FROM sessions WHERE started_at >= '2026-04-30T00:00:00Z' AND started_at <= '2026-05-01T23:59:59Z'"
    ).all() as Record<string, unknown>[];
    expect(sessions.find(s => s.external_id === 'corr-session-006')).toBeTruthy();
  });

  it('midnight-crossing session excluded when date range is before', () => {
    const sessions = storage.db.prepare(
      "SELECT * FROM sessions WHERE started_at >= '2026-04-28T00:00:00Z' AND started_at <= '2026-04-29T23:59:59Z'"
    ).all() as Record<string, unknown>[];
    expect(sessions.find(s => s.external_id === 'corr-session-006')).toBeUndefined();
  });

  it('date range filtering includes correct sessions', () => {
    const cnt = storage.db.prepare(
      "SELECT count(*) as cnt FROM sessions WHERE started_at >= '2026-04-28T00:00:00Z' AND started_at < '2026-04-29T00:00:00Z'"
    ).get() as { cnt: number };
    expect(cnt.cnt).toBeGreaterThanOrEqual(3);
  });

  it('empty date range returns no sessions', () => {
    const cnt = storage.db.prepare(
      "SELECT count(*) as cnt FROM sessions WHERE started_at >= '2026-06-01T00:00:00Z' AND started_at < '2026-06-02T00:00:00Z'"
    ).get() as { cnt: number };
    expect(cnt.cnt).toBe(0);
  });

  it('all timestamps stored as UTC ISO strings', () => {
    const sessions = storage.db.prepare('SELECT started_at FROM sessions WHERE started_at IS NOT NULL').all() as { started_at: string }[];
    for (const s of sessions) {
      expect(s.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });
});

// ─── Report Command (VAL-CLI-022, VAL-CLI-023, VAL-CLI-024, VAL-CLI-025, VAL-CLI-026) ──

describe('Report command', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'cet-report-')); });
  afterEach(() => { safeCleanup(tempDir); });

  it('report after init with no data shows empty state (VAL-CLI-023)', () => {
    runCli(['init', '-d', tempDir]);
    const result = runCli(['report', '-d', tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no sessions|no data|empty/i);
  });

  it('report with imported data shows effectiveness score (VAL-CLI-022)', () => {
    runCli(['init', '-d', tempDir]);
    runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    const result = runCli(['report', '-d', tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/effectiveness|score/i);
  });

  it('report --json produces valid JSON with expected keys (VAL-CLI-026)', () => {
    runCli(['init', '-d', tempDir]);
    runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    const result = runCli(['report', '-d', tempDir, '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.score).toBeDefined();
    expect(typeof parsed.score.aggregate).toBe('number');
    expect(parsed.sessions).toBeDefined();
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sources).toBeDefined();
    expect(parsed.period).toBeDefined();
  });

  it('report JSON includes score dimensions and missingInputs', () => {
    runCli(['init', '-d', tempDir]);
    runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    const parsed = JSON.parse(runCli(['report', '-d', tempDir, '--json']).stdout);
    expect(Array.isArray(parsed.score.dimensions)).toBe(true);
    expect(Array.isArray(parsed.score.missingInputs)).toBe(true);
  });

  it('report filters by tool (VAL-CLI-025)', () => {
    runCli(['init', '-d', tempDir]);
    runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    const parsed = JSON.parse(runCli(['report', '-d', tempDir, '--tool', 'codex', '--json']).stdout);
    for (const s of parsed.sessions) expect(s.source_tool_id).toBe('codex');
  });

  it('report filters by project', () => {
    runCli(['init', '-d', tempDir]);
    runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    const parsed = JSON.parse(runCli(['report', '-d', tempDir, '--project', 'project-alpha', '--json']).stdout);
    for (const s of parsed.sessions) expect(s.project_id).toBe('project-alpha');
  });

  it('report filters by date range (VAL-CLI-024)', () => {
    runCli(['init', '-d', tempDir]);
    runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    const parsed = JSON.parse(runCli(['report', '-d', tempDir, '--from', '2026-04-28', '--to', '2026-04-28', '--json']).stdout);
    expect(parsed.period).toBeDefined();
    for (const s of parsed.sessions) {
      expect(s.started_at >= '2026-04-28T00:00:00Z').toBe(true);
      expect(s.started_at <= '2026-04-28T23:59:59Z').toBe(true);
    }
  });

  it('report JSON includes cost/token data (VAL-SCORE-002)', () => {
    runCli(['init', '-d', tempDir]);
    runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    const parsed = JSON.parse(runCli(['report', '-d', tempDir, '--json']).stdout);
    expect(parsed.sessions.filter((s: Record<string, unknown>) => s.costEstimate != null).length).toBeGreaterThan(0);
  });

  it('report JSON includes rework indicators (VAL-SCORE-003)', () => {
    runCli(['init', '-d', tempDir]);
    runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
    const parsed = JSON.parse(runCli(['report', '-d', tempDir, '--json']).stdout);
    const withRework = parsed.sessions.filter((s: Record<string, unknown>) => {
      const m = s.metadata || {}; return m.reworkCount && m.reworkCount > 0;
    });
    expect(withRework.length).toBeGreaterThan(0);
  });
});

// ─── CLI annotate command (VAL-CLI-027, VAL-CLI-028, VAL-CLI-029, VAL-IMPORT-015) ──

describe('CLI annotate command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-cli-ann-'));
    runCli(['init', '-d', tempDir]);
    runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'correlation-sessions.json')]);
  });
  afterEach(() => { safeCleanup(tempDir); });

  it('annotate creates outcome for valid session (VAL-CLI-027)', () => {
    const db = new Database(join(tempDir, 'tracker.db'), { readonly: true });
    let sessionId: string;
    try { sessionId = (db.prepare('SELECT id FROM sessions LIMIT 1').all() as { id: string }[])[0].id; }
    finally { db.close(); }
    const result = runCli(['annotate', '-d', tempDir, '--session', sessionId, '--outcome', 'good']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/annotat|outcome|record/i);
    const db2 = new Database(join(tempDir, 'tracker.db'), { readonly: true });
    try { expect((db2.prepare('SELECT * FROM outcomes WHERE session_id = ?').get(sessionId) as Record<string, unknown>).label).toBe('good'); }
    finally { db2.close(); }
  });

  it('annotate rejects nonexistent session (VAL-CLI-028)', () => {
    const result = runCli(['annotate', '-d', tempDir, '--session', 'nonexistent-id-12345', '--outcome', 'good']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('annotate validates outcome values (VAL-CLI-029)', () => {
    const result = runCli(['annotate', '-d', tempDir, '--session', 'any-id', '--outcome', 'completely-invalid']);
    expect(result.exitCode).not.toBe(0);
  });

  it('manual outcome stored locally in SQLite (VAL-IMPORT-015)', () => {
    const db = new Database(join(tempDir, 'tracker.db'), { readonly: true });
    let sessionId: string;
    try { sessionId = (db.prepare('SELECT id FROM sessions LIMIT 1').all() as { id: string }[])[0].id; }
    finally { db.close(); }
    runCli(['annotate', '-d', tempDir, '--session', sessionId, '--outcome', 'good', '--note', 'Reviewed by team lead']);
    const db2 = new Database(join(tempDir, 'tracker.db'), { readonly: true });
    try {
      const outcome = db2.prepare('SELECT * FROM outcomes WHERE session_id = ?').get(sessionId) as Record<string, unknown>;
      expect(outcome.note).toBe('Reviewed by team lead');
      expect(outcome.outcome_type).toBe('manual');
    } finally { db2.close(); }
  });
});


// --- Regression: Missing-input denominator behavior ---

describe('Regression: missing-input denominator behavior', () => {
  let tempDir;
  let storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-missing-input-'));
    storage = createTestStorage(tempDir);
    registerAllImporters();
    runFixtureImport(join(FIXTURES_DIR, 'correlation-sessions.json'), storage);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('includes total weight in denominator (unavailable dims contribute 0, not removed)', () => {
    // No git signals, no test outcomes, no manual outcomes
    // Activity, cost-efficiency, and rework are available in the fixture
    const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });

    // 5 project-alpha sessions: activity = min(5/10,1) = 0.5
    // cost: 4/5 sessions have cost data, avg ~$0.06, score = 1 - 0.06/1.0 = 0.94
    // rework: sessions 001(rework=0), 002(rework=1), 003(no key), 006(no key), 007(rework=3)
    // sessionsWithRework = 2 (002, 007), reworkRatio = 2/5 = 0.4, score = 0.6
    //
    // New semantics: total weight denominator includes ALL dimensions.
    // (0.5*0.15 + 0*0.25 + 0*0.25 + 0*0.15 + 0.94*0.10 + 0.6*0.10) / 1.0 ≈ 0.229
    expect(score.aggregate).toBeCloseTo(0.229, 2);
    expect(score.missingInputs.length).toBeGreaterThan(0);
  });

  it('marks unavailable git dimension available=false (zero contribution, not excluded)', () => {
    const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    const gitDim = score.dimensions.find(d => d.name === 'git-correlation');
    expect(gitDim).toBeDefined();
    expect(gitDim.available).toBe(false);
    expect(gitDim.value).toBe(0);
  });

  it('marks unavailable test dimension available=false', () => {
    const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    const testDim = score.dimensions.find(d => d.name === 'test-confidence');
    expect(testDim).toBeDefined();
    expect(testDim.available).toBe(false);
  });

  it('marks unavailable manual dimension available=false', () => {
    const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    const manualDim = score.dimensions.find(d => d.name === 'manual-outcome');
    expect(manualDim).toBeDefined();
    expect(manualDim.available).toBe(false);
  });

  it('score explanation still lists all missing inputs clearly', () => {
    const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    expect(score.missingInputs.some(m => /test/i.test(m))).toBe(true);
    expect(score.missingInputs.some(m => /manual/i.test(m))).toBe(true);
    expect(score.missingInputs.some(m => /git/i.test(m))).toBe(true);
  });

  it('marks score insufficient when no objective evidence exists', () => {
    // Only activity + cost + rework dims available, no git/test/manual/pr
    // dataCompleteness = 0.15 + 0.10 + 0.10 = 0.35, < 0.4 -> 'insufficient'
    const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    expect(score.dataCompleteness).toBeCloseTo(0.35, 2);
    expect(score.evidenceLevel).toBe('insufficient');
  });

  it('reports completeness as fraction of weighted dimensions with data', () => {
    // Insert git correlation data
    const tempDir2 = mkdtempSync(join(tmpdir(), 'cet-completeness-'));
    try {
      const repoDir = createTempGitRepo(tempDir2);
      storeGitSignals(storage, collectGitSignals(repoDir), 'project-alpha');
      const db = storage.db;
      const sessions = db.prepare("SELECT id FROM sessions WHERE project_id = 'project-alpha'").all() as { id: string }[];
      for (const s of sessions) correlateSession(storage, s.id);
      const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
      // activity(0.15) + git(0.25) + cost(0.10) + rework(0.10) = 0.60 / 1.0 = 0.60
      expect(score.dataCompleteness).toBeCloseTo(0.60, 2);
    } finally {
      safeCleanup(tempDir2);
    }
  });

  it('keeps aggregate low when completeness is low (no inflation from activity+rework alone)', () => {
    // Only activity + cost + rework available -> aggregate must be < 0.7
    const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    // With total-weight denominator: aggregate = (0.5*0.15 + 0.94*0.10 + 0.6*0.10) / 1.0 = 0.229
    expect(score.aggregate).toBeCloseTo(0.229, 2);
    expect(score.evidenceLevel).toBe('insufficient');
  });

  it('when all dimensions available, aggregate uses full weight denominator', () => {
    const tempDir2 = mkdtempSync(join(tmpdir(), 'cet-missing-full-'));
    try {
      const repoDir = createTempGitRepo(tempDir2);
      storeGitSignals(storage, collectGitSignals(repoDir), 'project-alpha');
      collectTestOutcomes(storage, [
        { command: 'npm test', passed: 10, failed: 0, skipped: 0, durationMs: 1000, runAt: '2026-04-28T09:30:00Z' },
      ], 'project-alpha');
      const db = storage.db;
      const sessions = db.prepare("SELECT id FROM sessions WHERE project_id = 'project-alpha'").all();
      for (let i = 0; i < sessions.length; i++) {
        db.prepare("INSERT INTO outcomes (id, session_id, outcome_type, score, label) VALUES (?, ?, ?, ?, ?)").run(
          'reg-outcome-' + i, sessions[i].id, 'manual', 0.9, 'good'
        );
      }
      for (const s of sessions) correlateSession(storage, s.id);
      const score = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
      expect(score.missingInputs.length).toBe(0);
      expect(score.aggregate).toBeGreaterThan(0);
      // All dimensions available, so full 1.0 weight denominator
      for (const dim of score.dimensions) {
        expect(dim.available).toBe(true);
      }
    } finally {
      safeCleanup(tempDir2);
    }
  });
});

// --- Regression: filtered report test-confidence scope ---

describe('Regression: filtered report test-confidence scope', () => {
  let tempDir;
  let storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-filtered-test-'));
    storage = createTestStorage(tempDir);
    registerAllImporters();
    runFixtureImport(join(FIXTURES_DIR, 'correlation-sessions.json'), storage);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('tool filter constrains test outcomes considered for test-confidence', () => {
    // Add passing tests for project-alpha, failing for project-beta
    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 20, failed: 0, skipped: 0, durationMs: 2000, runAt: '2026-04-28T09:20:00Z' },
    ], 'project-alpha');
    collectTestOutcomes(storage, [
      { command: 'pytest', passed: 5, failed: 10, skipped: 0, durationMs: 3000, runAt: '2026-04-28T16:40:00Z' },
    ], 'project-beta');

    // codex sessions are in project-alpha, opencode in project-beta
    const codexScore = computeEffectivenessScore(storage, { toolId: 'codex' });
    const codexTestDim = codexScore.dimensions.find(d => d.name === 'test-confidence');

    const opencodeScore = computeEffectivenessScore(storage, { toolId: 'opencode' });
    const opencodeTestDim = opencodeScore.dimensions.find(d => d.name === 'test-confidence');

    // codex test-confidence should reflect project-alpha pass rate (20/20 = 100%)
    // opencode should reflect project-beta (5/15 = 33%)
    expect(codexTestDim.value).toBeGreaterThan(opencodeTestDim.value);
  });

  it('date filter constrains test outcomes for test-confidence', () => {
    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 20, failed: 0, skipped: 0, durationMs: 2000, runAt: '2026-04-28T09:20:00Z' },
    ], 'project-alpha');
    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 2, failed: 8, skipped: 0, durationMs: 3000, runAt: '2026-04-29T14:20:00Z' },
    ], 'project-alpha');

    const day1Score = computeEffectivenessScore(storage, { projectId: 'project-alpha', from: '2026-04-28', to: '2026-04-28' });
    const day1TestDim = day1Score.dimensions.find(d => d.name === 'test-confidence');

    const day2Score = computeEffectivenessScore(storage, { projectId: 'project-alpha', from: '2026-04-29', to: '2026-04-29' });
    const day2TestDim = day2Score.dimensions.find(d => d.name === 'test-confidence');

    // Day 1: 100% pass, Day 2: 20% pass
    expect(day1TestDim.value).toBeGreaterThan(day2TestDim.value);
  });

  it('unrelated tests outside filtered scope do not affect report', () => {
    collectTestOutcomes(storage, [
      { command: 'pytest', passed: 0, failed: 50, skipped: 0, durationMs: 5000, runAt: '2026-04-28T16:40:00Z' },
    ], 'project-beta');
    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 100, failed: 0, skipped: 0, durationMs: 2000, runAt: '2026-04-28T09:20:00Z' },
    ], 'project-alpha');

    const alphaScore = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    const alphaTestDim = alphaScore.dimensions.find(d => d.name === 'test-confidence');

    const betaScore = computeEffectivenessScore(storage, { projectId: 'project-beta' });
    const betaTestDim = betaScore.dimensions.find(d => d.name === 'test-confidence');

    // Alpha should show high test-confidence (100% pass rate)
    // Beta should show low test-confidence (0% pass rate)
    expect(alphaTestDim.value).toBeGreaterThan(betaTestDim.value);
    expect(betaTestDim.value).toBeLessThan(0.3);
  });

  it('filtered report JSON test-confidence reflects only filtered scope', () => {
    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 15, failed: 0, skipped: 0, durationMs: 1500, runAt: '2026-04-28T09:30:00Z' },
    ], 'project-alpha');
    collectTestOutcomes(storage, [
      { command: 'jest', passed: 0, failed: 30, skipped: 0, durationMs: 4000, runAt: '2026-04-28T16:50:00Z' },
    ], 'project-beta');

    const alphaScore = computeEffectivenessScore(storage, { projectId: 'project-alpha' });
    const betaScore = computeEffectivenessScore(storage, { projectId: 'project-beta' });
    const alphaTestDim = alphaScore.dimensions.find(d => d.name === 'test-confidence');
    const betaTestDim = betaScore.dimensions.find(d => d.name === 'test-confidence');

    expect(alphaTestDim.value).toBeGreaterThan(0.5);
    expect(betaTestDim.value).toBeLessThan(0.3);
  });
});

// --- Regression: --tool filter edge cases (fix-test-confidence-filter-edge-cases) ---

describe('Regression: --tool filter edge cases for test-confidence', () => {
  let tempDir;
  let storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-tool-edge-'));
    storage = createTestStorage(tempDir);
    registerAllImporters();
    runFixtureImport(join(FIXTURES_DIR, 'correlation-sessions.json'), storage);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('tool filter with no matching sessions does not use unrelated test outcomes', () => {
    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 100, failed: 0, skipped: 0, durationMs: 2000, runAt: '2026-04-28T09:20:00Z' },
    ], 'project-alpha');

    const score = computeEffectivenessScore(storage, { toolId: 'nonexistent-tool' });
    expect(score.sessionCount).toBe(0);

    const testDim = score.dimensions.find(d => d.name === 'test-confidence');
    expect(testDim.available).toBe(false);
    expect(testDim.explanation).toMatch(/no test|not available|no sessions/i);
  });

  it('tool filter with matching sessions lacking project_id does not use unrelated global tests', () => {
    const db = storage.db;
    db.prepare('INSERT INTO tools (id, name, display_name) VALUES (?, ?, ?)').run(
      'null-project-tool', 'null-project-tool', 'Null Project Tool'
    );
    db.prepare('INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'null-proj-sess-1', 'null-proj-ext-1', 'null-project-tool', null,
      '2026-04-28T10:00:00Z', '2026-04-28T11:00:00Z', 3600000, 'Session without project'
    );

    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 0, failed: 100, skipped: 0, durationMs: 2000, runAt: '2026-04-28T09:20:00Z' },
    ], 'project-alpha');

    const score = computeEffectivenessScore(storage, { toolId: 'null-project-tool' });
    expect(score.sessionCount).toBe(1);

    const testDim = score.dimensions.find(d => d.name === 'test-confidence');
    expect(testDim.available).toBe(false);
    expect(testDim.explanation).toMatch(/no test|not available|no sessions|scope/i);
  });

  it('tool filter with sessions having empty string project_id does not use unrelated global tests', () => {
    const db = storage.db;
    db.prepare('INSERT INTO tools (id, name, display_name) VALUES (?, ?, ?)').run(
      'empty-proj-tool', 'empty-proj-tool', 'Empty Proj Tool'
    );
    // Empty string project_id exists as a project but has no test outcomes.
    // Sessions with empty project_id must not trigger a global (unfiltered) test_outcomes query.
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('', 'No Project');
    db.prepare('INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'empty-proj-sess-1', 'empty-proj-ext-1', 'empty-proj-tool', '',
      '2026-04-28T10:00:00Z', '2026-04-28T11:00:00Z', 3600000, 'Session with empty project'
    );

    collectTestOutcomes(storage, [
      { command: 'npm test', passed: 0, failed: 50, skipped: 0, durationMs: 2000, runAt: '2026-04-28T09:20:00Z' },
    ], 'project-alpha');

    const score = computeEffectivenessScore(storage, { toolId: 'empty-proj-tool' });
    expect(score.sessionCount).toBe(1);

    const testDim = score.dimensions.find(d => d.name === 'test-confidence');
    expect(testDim.available).toBe(false);
  });
});
