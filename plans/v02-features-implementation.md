# v0.2.0 Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three additive features for coding-effectiveness-tracker v0.2.0: `cet diff` (code impact), `cet sync --pr` (ship status via GitHub PRs), `cet prompt-quality` (heuristic prompt scoring).

**Architecture:** Each feature is isolated (new module + CLI subcommand + API route + React surface). One SQL migration adds the `session_diffs` table + `prompt_quality_json` column on sessions. PR state is derived from correlations (no redundant column). All features opt-in, no breaking changes.

**Tech Stack:** TypeScript 5 / Node 20+ / better-sqlite3 / Fastify / React 19 / Vite / commander / vitest / Playwright.

**Spec:** `plans/v02-features-design.md`

---

## File Structure

### New files

- `src/analytics/diff-service.ts` — git diff fetch + cache + size policy
- `src/analytics/prompt-quality/types.ts` — `PromptAnalyzer` interface + result types
- `src/analytics/prompt-quality/heuristic-v1.ts` — built-in analyzer
- `src/analytics/prompt-quality/registry.ts` — analyzer lookup by id
- `src/analytics/prompt-quality/service.ts` — compute + store + retrieve orchestration
- `src/correlation/pr-outcomes.ts` — gh CLI invocation + classification + revert detection
- `src/correlation/ship-status.ts` — derive ship status from correlations for a session set
- `src/commands/diff.ts` — CLI subcommand
- `src/commands/prompt-quality.ts` — CLI subcommand
- `src/dashboard/components/DiffPanel.tsx` — inline diff viewer
- `src/dashboard/components/PromptQualityPage.tsx` — dashboard page + scatter
- `src/dashboard/components/PRCard.tsx` — PR list card for SessionDetailView
- `src/dashboard/components/ShipStatusPill.tsx` — colored ship status pill
- `tests/diff-service.test.ts`
- `tests/prompt-quality.test.ts`
- `tests/pr-outcomes.test.ts`
- `tests/ship-status.test.ts`

### Modified files

- `src/storage.ts` — new migration entry `002_v02_features`
- `src/cli.ts` — register `diff`, `prompt-quality` subcommands, add `--pr` flag to `sync`
- `src/commands/sync.ts` — integrate PR fetch when `--pr` flag passed
- `src/api/routes.ts` — new routes, timeline/overview/session-detail enriched with ship status + prompt quality
- `src/api/contract.ts` — new response types for diff, prompt-quality, ship-status
- `src/dashboard/components/SessionDetailView.tsx` — mount DiffPanel + PRCard + prompt-quality card
- `src/dashboard/components/TimelinePage.tsx` — new "Ship" column
- `src/dashboard/components/OverviewPage.tsx` — new "Ship rate" card
- `src/dashboard/components/App.tsx` — route `/prompting` → PromptQualityPage
- `docs/scoring.md` — document opt-in `shipRate` dimension
- `docs/api-reference.md` — document new endpoints
- `README.md` — CLI table includes 3 new commands
- `CHANGELOG.md` — `[0.2.0]` section

---

## Prep Phase

### Task 0: Migration 002 — add session_diffs table + prompt_quality_json column

**Files:**
- Modify: `src/storage.ts` (within `getMigrations()` array)
- Test: `tests/storage.test.ts` (existing)

- [ ] **Step 1: Write the failing test**

Append to `tests/storage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../src/storage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('migration 002_v02_features', () => {
  let dir: string;
  let storage: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cet-mig-'));
    storage = Storage.open(join(dir, 'tracker.db'));
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates session_diffs table with unique(session_id, commit_hash)', () => {
    const row = storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_diffs'")
      .get();
    expect(row).toBeDefined();
    const idx = storage.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='session_diffs'")
      .all() as { sql: string | null }[];
    const unique = idx.find((r) => r.sql?.includes('UNIQUE'));
    expect(unique).toBeTruthy();
  });

  it('adds prompt_quality_json column to sessions', () => {
    const cols = storage.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    expect(cols.some((c) => c.name === 'prompt_quality_json')).toBe(true);
  });

  it('migration 002 is recorded in _migrations', () => {
    const names = storage.db
      .prepare('SELECT name FROM _migrations ORDER BY id')
      .all() as { name: string }[];
    expect(names.map((n) => n.name)).toContain('002_v02_features');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:unit -- tests/storage.test.ts
```

Expected: FAIL on all three new tests.

- [ ] **Step 3: Add migration to `getMigrations()` in `src/storage.ts`**

In the array returned by `getMigrations()`, append after `001_core_schema`:

```typescript
    {
      name: '002_v02_features',
      sql: `
        CREATE TABLE IF NOT EXISTS session_diffs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          commit_hash TEXT NOT NULL,
          diff_text TEXT,
          stats_json TEXT NOT NULL,
          cached_at INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          skipped_reason TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_diffs_unique
          ON session_diffs(session_id, commit_hash);

        CREATE INDEX IF NOT EXISTS idx_session_diffs_session
          ON session_diffs(session_id);

        ALTER TABLE sessions ADD COLUMN prompt_quality_json TEXT;
      `,
    },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:unit -- tests/storage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts tests/storage.test.ts
git commit -m "feat(storage): migration 002 adds session_diffs + prompt_quality_json"
```

---

### Task 0b: ship-status helper

**Files:**
- Create: `src/correlation/ship-status.ts`
- Test: `tests/ship-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ship-status.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../src/storage.js';
import { deriveShipStatus, type ShipStatus } from '../src/correlation/ship-status.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function seedSession(storage: Storage, id: string, hasCommit = false): void {
  storage.db.prepare('INSERT INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t1', 't1', 'T1');
  storage.db.prepare('INSERT INTO sessions (id, source_tool_id) VALUES (?, ?)').run(id, 't1');
  if (hasCommit) {
    storage.db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
    ).run(randomUUID(), id, 'commit-abc');
  }
}

function seedPR(
  storage: Storage,
  sessionId: string,
  state: 'merged' | 'closed' | 'open',
  reverted = false,
): void {
  storage.db.prepare(
    `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
     VALUES (?, ?, 'pr-outcome', ?, 1, ?)`,
  ).run(randomUUID(), sessionId, '42', JSON.stringify({ state, reverted, prNumber: 42 }));
}

describe('deriveShipStatus', () => {
  let dir: string;
  let storage: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cet-ship-'));
    storage = Storage.open(join(dir, 'tracker.db'));
  });
  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns "unlinked" when no commit correlations exist', () => {
    seedSession(storage, 's1');
    const result = deriveShipStatus(storage.db, ['s1']);
    expect(result.get('s1')).toBe<ShipStatus>('unlinked');
  });

  it('returns null when commits exist but no PR correlation', () => {
    seedSession(storage, 's1', true);
    const result = deriveShipStatus(storage.db, ['s1']);
    expect(result.get('s1')).toBeNull();
  });

  it('returns "shipped" for merged non-reverted PR', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'merged', false);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('shipped');
  });

  it('returns "reverted" for merged reverted PR', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'merged', true);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('reverted');
  });

  it('returns "abandoned" for closed unmerged PR', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'closed', false);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('abandoned');
  });

  it('returns "in-flight" for open PR', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'open', false);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('in-flight');
  });

  it('batches N sessions in one query (no N+1)', () => {
    for (let i = 0; i < 50; i++) seedSession(storage, `s${i}`, true);
    let prepareCalls = 0;
    const origPrepare = storage.db.prepare.bind(storage.db);
    (storage.db as { prepare: typeof storage.db.prepare }).prepare = ((sql: string) => {
      prepareCalls++;
      return origPrepare(sql);
    }) as typeof storage.db.prepare;
    const ids = Array.from({ length: 50 }, (_, i) => `s${i}`);
    deriveShipStatus(storage.db, ids);
    expect(prepareCalls).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:unit -- tests/ship-status.test.ts
```

Expected: FAIL on import (`deriveShipStatus` not found).

- [ ] **Step 3: Implement `src/correlation/ship-status.ts`**

```typescript
import type Database from 'better-sqlite3';

export type ShipStatus = 'shipped' | 'reverted' | 'abandoned' | 'in-flight' | 'unlinked';

interface Row {
  session_id: string;
  has_commit: number;
  has_merged: number;
  has_reverted: number;
  has_closed: number;
  has_open: number;
}

/**
 * Derive ship status for a batch of session IDs. Single query via json_each.
 * Priority: shipped > reverted > in-flight > abandoned > null (has commits, no PR) > unlinked.
 */
export function deriveShipStatus(
  db: Database.Database,
  sessionIds: string[],
): Map<string, ShipStatus | null> {
  const result = new Map<string, ShipStatus | null>();
  if (sessionIds.length === 0) return result;

  const rows = db
    .prepare(
      `
      SELECT
        s.id AS session_id,
        MAX(CASE WHEN c.correlation_type = 'git-commit' THEN 1 ELSE 0 END) AS has_commit,
        MAX(CASE WHEN c.correlation_type = 'pr-outcome'
                 AND json_extract(c.metadata_json, '$.state') = 'merged'
                 AND COALESCE(json_extract(c.metadata_json, '$.reverted'), 0) = 0
            THEN 1 ELSE 0 END) AS has_merged,
        MAX(CASE WHEN c.correlation_type = 'pr-outcome'
                 AND json_extract(c.metadata_json, '$.state') = 'merged'
                 AND json_extract(c.metadata_json, '$.reverted') = 1
            THEN 1 ELSE 0 END) AS has_reverted,
        MAX(CASE WHEN c.correlation_type = 'pr-outcome'
                 AND json_extract(c.metadata_json, '$.state') = 'closed'
            THEN 1 ELSE 0 END) AS has_closed,
        MAX(CASE WHEN c.correlation_type = 'pr-outcome'
                 AND json_extract(c.metadata_json, '$.state') = 'open'
            THEN 1 ELSE 0 END) AS has_open
      FROM sessions s
      LEFT JOIN correlations c ON c.session_id = s.id
      WHERE s.id IN (SELECT value FROM json_each(?))
      GROUP BY s.id
      `,
    )
    .all(JSON.stringify(sessionIds)) as Row[];

  for (const row of rows) {
    let status: ShipStatus | null;
    if (row.has_reverted) status = 'reverted';
    else if (row.has_merged) status = 'shipped';
    else if (row.has_open) status = 'in-flight';
    else if (row.has_closed) status = 'abandoned';
    else if (row.has_commit) status = null;
    else status = 'unlinked';
    result.set(row.session_id, status);
  }

  for (const id of sessionIds) {
    if (!result.has(id)) result.set(id, 'unlinked');
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:unit -- tests/ship-status.test.ts
```

Expected: PASS all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add src/correlation/ship-status.ts tests/ship-status.test.ts
git commit -m "feat(correlation): add deriveShipStatus helper"
```

---

## Feature 1: cet diff

### Task 1.1: diff-service — fetch, size policy, cache

**Files:**
- Create: `src/analytics/diff-service.ts`
- Test: `tests/diff-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/diff-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../src/storage.js';
import { getSessionDiffs, DIFF_SIZE_CAP_BYTES } from '../src/analytics/diff-service.js';
import { randomUUID } from 'node:crypto';

function makeRepo(): { dir: string; hashSmall: string; hashLarge: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cet-diff-repo-'));
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { cwd: dir, encoding: 'utf-8' });
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 't@t']);
  run('git', ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  run('git', ['add', 'a.txt']);
  run('git', ['commit', '-q', '-m', 'initial']);
  writeFileSync(join(dir, 'a.txt'), 'hello world\n');
  run('git', ['add', 'a.txt']);
  run('git', ['commit', '-q', '-m', 'small change']);
  const hashSmall = run('git', ['rev-parse', 'HEAD']).trim();
  const big = 'x'.repeat(DIFF_SIZE_CAP_BYTES + 1000) + '\n';
  writeFileSync(join(dir, 'big.txt'), big);
  run('git', ['add', 'big.txt']);
  run('git', ['commit', '-q', '-m', 'large change']);
  const hashLarge = run('git', ['rev-parse', 'HEAD']).trim();
  return { dir, hashSmall, hashLarge };
}

function seedCommit(storage: Storage, sessionId: string, hash: string): void {
  storage.db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t1', 't1', 'T1');
  storage.db.prepare('INSERT INTO sessions (id, source_tool_id) VALUES (?, ?)').run(sessionId, 't1');
  const commitRow = randomUUID();
  storage.db.prepare(
    `INSERT INTO git_commits (id, hash, short_hash, message, project_id)
     VALUES (?, ?, ?, ?, NULL)`,
  ).run(commitRow, hash, hash.slice(0, 7), 'test commit');
  storage.db.prepare(
    `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
     VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
  ).run(randomUUID(), sessionId, commitRow);
}

describe('diff-service', () => {
  let dbDir: string;
  let storage: Storage;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'cet-diff-db-'));
    storage = Storage.open(join(dbDir, 'tracker.db'));
    repo = makeRepo();
  });
  afterEach(() => {
    storage.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  });

  it('returns diff text + stats for small commit and caches result', () => {
    seedCommit(storage, 's1', repo.hashSmall);
    const first = getSessionDiffs(storage.db, 's1', { repoPath: repo.dir });
    expect(first).toHaveLength(1);
    expect(first[0].stats.files).toBe(1);
    expect(first[0].stats.insertions).toBeGreaterThan(0);
    expect(first[0].diff).toContain('hello world');
    expect(first[0].skipped).toBeUndefined();

    const cached = storage.db.prepare(
      'SELECT diff_text FROM session_diffs WHERE session_id = ? AND commit_hash = ?',
    ).get('s1', repo.hashSmall) as { diff_text: string | null };
    expect(cached.diff_text).toContain('hello world');
  });

  it('skips text for oversized diff, keeps stats', () => {
    seedCommit(storage, 's2', repo.hashLarge);
    const result = getSessionDiffs(storage.db, 's2', { repoPath: repo.dir });
    expect(result[0].stats.files).toBe(1);
    expect(result[0].skipped).toBe('too-large');
    expect(result[0].diff).toBeUndefined();
  });

  it('skips with repo-missing when path absent', () => {
    seedCommit(storage, 's3', repo.hashSmall);
    const result = getSessionDiffs(storage.db, 's3', { repoPath: '/no/such/path' });
    expect(result[0].skipped).toBe('repo-missing');
    expect(result[0].diff).toBeUndefined();
  });

  it('cache hit bypasses git exec on second call', () => {
    seedCommit(storage, 's4', repo.hashSmall);
    getSessionDiffs(storage.db, 's4', { repoPath: repo.dir });
    const before = storage.db.prepare('SELECT cached_at FROM session_diffs WHERE session_id=?').get('s4') as { cached_at: number };
    getSessionDiffs(storage.db, 's4', { repoPath: repo.dir });
    const after = storage.db.prepare('SELECT cached_at FROM session_diffs WHERE session_id=?').get('s4') as { cached_at: number };
    expect(after.cached_at).toBe(before.cached_at);
  });

  it('refresh=true re-fetches and updates cache', () => {
    seedCommit(storage, 's5', repo.hashSmall);
    getSessionDiffs(storage.db, 's5', { repoPath: repo.dir });
    const before = storage.db.prepare('SELECT cached_at FROM session_diffs WHERE session_id=?').get('s5') as { cached_at: number };
    const fresh = getSessionDiffs(storage.db, 's5', { repoPath: repo.dir, refresh: true });
    expect(fresh[0].diff).toBeDefined();
    const after = storage.db.prepare('SELECT cached_at FROM session_diffs WHERE session_id=?').get('s5') as { cached_at: number };
    expect(after.cached_at).toBeGreaterThanOrEqual(before.cached_at);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:unit -- tests/diff-service.test.ts
```

Expected: FAIL on import.

- [ ] **Step 3: Implement `src/analytics/diff-service.ts`**

```typescript
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const DIFF_SIZE_CAP_BYTES = 100 * 1024;

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface SessionCommitDiff {
  hash: string;
  shortHash: string;
  message: string | null;
  stats: DiffStats;
  diff?: string;
  skipped?: 'too-large' | 'repo-missing';
}

export interface GetDiffsOptions {
  repoPath: string;
  refresh?: boolean;
}

interface CommitRow {
  hash: string;
  short_hash: string;
  message: string | null;
}

interface CacheRow {
  diff_text: string | null;
  stats_json: string;
  skipped_reason: string | null;
  cached_at: number;
}

export function getSessionDiffs(
  db: Database.Database,
  sessionId: string,
  opts: GetDiffsOptions,
): SessionCommitDiff[] {
  const commits = db
    .prepare(
      `
      SELECT g.hash, g.short_hash, g.message
      FROM correlations c
      JOIN git_commits g ON g.id = c.target_id
      WHERE c.session_id = ? AND c.correlation_type = 'git-commit'
      ORDER BY g.authored_at
      `,
    )
    .all(sessionId) as CommitRow[];

  const repoExists = existsSync(opts.repoPath);
  const result: SessionCommitDiff[] = [];

  for (const c of commits) {
    const cached = opts.refresh
      ? undefined
      : (db.prepare(
          'SELECT diff_text, stats_json, skipped_reason, cached_at FROM session_diffs WHERE session_id = ? AND commit_hash = ?',
        ).get(sessionId, c.hash) as CacheRow | undefined);

    if (cached) {
      result.push(fromCache(c, cached));
      continue;
    }

    if (!repoExists) {
      upsert(db, sessionId, c.hash, null, { files: 0, insertions: 0, deletions: 0 }, 'repo-missing');
      result.push({
        hash: c.hash,
        shortHash: c.short_hash,
        message: c.message,
        stats: { files: 0, insertions: 0, deletions: 0 },
        skipped: 'repo-missing',
      });
      continue;
    }

    const stats = getStats(opts.repoPath, c.hash);
    const raw = getDiffText(opts.repoPath, c.hash);
    const size = Buffer.byteLength(raw, 'utf-8');

    if (size > DIFF_SIZE_CAP_BYTES) {
      upsert(db, sessionId, c.hash, null, stats, 'too-large');
      result.push({ hash: c.hash, shortHash: c.short_hash, message: c.message, stats, skipped: 'too-large' });
    } else {
      upsert(db, sessionId, c.hash, raw, stats, null);
      result.push({ hash: c.hash, shortHash: c.short_hash, message: c.message, stats, diff: raw });
    }
  }

  return result;
}

function fromCache(c: CommitRow, row: CacheRow): SessionCommitDiff {
  const stats = JSON.parse(row.stats_json) as DiffStats;
  const base = { hash: c.hash, shortHash: c.short_hash, message: c.message, stats };
  if (row.skipped_reason === 'too-large') return { ...base, skipped: 'too-large' };
  if (row.skipped_reason === 'repo-missing') return { ...base, skipped: 'repo-missing' };
  return { ...base, diff: row.diff_text ?? '' };
}

function getStats(repoPath: string, hash: string): DiffStats {
  const out = execFileSync(
    'git',
    ['show', '--numstat', '--format=', hash],
    { cwd: repoPath, encoding: 'utf-8' },
  );
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files++;
    const ins = parseInt(parts[0], 10);
    const del = parseInt(parts[1], 10);
    if (!Number.isNaN(ins)) insertions += ins;
    if (!Number.isNaN(del)) deletions += del;
  }
  return { files, insertions, deletions };
}

function getDiffText(repoPath: string, hash: string): string {
  return execFileSync('git', ['show', '--format=', hash], {
    cwd: repoPath,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function upsert(
  db: Database.Database,
  sessionId: string,
  hash: string,
  diffText: string | null,
  stats: DiffStats,
  skipped: string | null,
): void {
  const now = Date.now();
  const size = diffText ? Buffer.byteLength(diffText, 'utf-8') : 0;
  db.prepare(
    `INSERT INTO session_diffs (id, session_id, commit_hash, diff_text, stats_json, cached_at, size_bytes, skipped_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, commit_hash) DO UPDATE SET
       diff_text = excluded.diff_text,
       stats_json = excluded.stats_json,
       cached_at = excluded.cached_at,
       size_bytes = excluded.size_bytes,
       skipped_reason = excluded.skipped_reason`,
  ).run(randomUUID(), sessionId, hash, diffText, JSON.stringify(stats), now, size, skipped);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:unit -- tests/diff-service.test.ts
```

Expected: PASS all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/diff-service.ts tests/diff-service.test.ts
git commit -m "feat(diff): diff-service with size cap + sqlite cache"
```

---

### Task 1.2: CLI command `cet diff`

**Files:**
- Create: `src/commands/diff.ts`
- Modify: `src/cli.ts` (register command)
- Test: append to `tests/e2e.test.ts` OR new `tests/cli-diff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli-diff.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../src/storage.js';
import { randomUUID } from 'node:crypto';

const CLI = resolve(process.cwd(), 'dist/cli.js');

function mkRepo(): { dir: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-diff-repo-'));
  const run = (c: string, a: string[]) => execFileSync(c, a, { cwd: dir, encoding: 'utf-8' });
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 't@t']);
  run('git', ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'f.txt'), 'a\n');
  run('git', ['add', 'f.txt']);
  run('git', ['commit', '-q', '-m', 'init']);
  writeFileSync(join(dir, 'f.txt'), 'a\nb\n');
  run('git', ['add', 'f.txt']);
  run('git', ['commit', '-q', '-m', 'change']);
  const hash = run('git', ['rev-parse', 'HEAD']).trim();
  return { dir, hash };
}

describe('cet diff CLI', () => {
  let dataDir: string;
  let storage: Storage;
  let repo: ReturnType<typeof mkRepo>;
  let sessionId: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cli-diff-data-'));
    storage = Storage.open(join(dataDir, 'tracker.db'));
    repo = mkRepo();
    sessionId = randomUUID();
    storage.db.prepare('INSERT INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t', 't', 'T');
    storage.db.prepare('INSERT INTO sessions (id, source_tool_id) VALUES (?, ?)').run(sessionId, 't');
    const commitId = randomUUID();
    storage.db.prepare(
      'INSERT INTO git_commits (id, hash, short_hash, message) VALUES (?, ?, ?, ?)',
    ).run(commitId, repo.hash, repo.hash.slice(0, 7), 'change');
    storage.db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
    ).run(randomUUID(), sessionId, commitId);
    storage.close();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  });

  it('prints diff text', () => {
    const out = execFileSync('node', [CLI, 'diff', sessionId, '--data-dir', dataDir, '--repo', repo.dir], {
      encoding: 'utf-8',
    });
    expect(out).toContain('+b');
  });

  it('--stats prints counts only', () => {
    const out = execFileSync('node', [CLI, 'diff', sessionId, '--data-dir', dataDir, '--repo', repo.dir, '--stats'], {
      encoding: 'utf-8',
    });
    expect(out).toMatch(/1 file/);
    expect(out).toMatch(/\+1/);
    expect(out).not.toContain('+b\n');
  });

  it('--files lists changed files', () => {
    const out = execFileSync('node', [CLI, 'diff', sessionId, '--data-dir', dataDir, '--repo', repo.dir, '--files'], {
      encoding: 'utf-8',
    });
    expect(out).toContain('f.txt');
  });

  it('errors when session not found', () => {
    expect(() =>
      execFileSync('node', [CLI, 'diff', 'missing-id', '--data-dir', dataDir, '--repo', repo.dir], {
        encoding: 'utf-8',
      }),
    ).toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test (will fail — command not registered)**

```bash
npm run build && npm run test:unit -- tests/cli-diff.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/diff.ts`**

```typescript
import { Storage } from '../storage.js';
import { getSessionDiffs } from '../analytics/diff-service.js';
import { resolve } from 'node:path';

export interface DiffCommandOptions {
  dataDir: string;
  repo?: string;
  commit?: string;
  stats?: boolean;
  files?: boolean;
  noCache?: boolean;
}

export async function runDiffCommand(sessionId: string, opts: DiffCommandOptions): Promise<void> {
  const storage = Storage.open(resolve(opts.dataDir, 'tracker.db'));
  try {
    const session = storage.db.prepare('SELECT id, metadata_json FROM sessions WHERE id = ?').get(sessionId) as
      | { id: string; metadata_json: string | null }
      | undefined;
    if (!session) {
      process.stderr.write(`Session not found: ${sessionId}\n`);
      process.exitCode = 1;
      return;
    }

    const repoPath = opts.repo ?? parseRepoFromMetadata(session.metadata_json);
    if (!repoPath) {
      process.stderr.write('Repo path required: pass --repo <path> or set project repo via `cet sync --repo <path>`\n');
      process.exitCode = 1;
      return;
    }

    const diffs = getSessionDiffs(storage.db, sessionId, {
      repoPath,
      refresh: opts.noCache === true,
    });

    let filtered = diffs;
    if (opts.commit) filtered = diffs.filter((d) => d.hash.startsWith(opts.commit!));
    if (filtered.length === 0) {
      process.stdout.write('No commits linked to this session\n');
      return;
    }

    for (const d of filtered) {
      if (opts.stats) {
        process.stdout.write(
          `${d.shortHash} ${d.stats.files} file${d.stats.files === 1 ? '' : 's'}, +${d.stats.insertions}/-${d.stats.deletions}\n`,
        );
        continue;
      }
      if (opts.files) {
        process.stdout.write(`${d.shortHash} ${d.message ?? ''}\n`);
        if (d.diff) for (const f of filesFromDiff(d.diff)) process.stdout.write(`  ${f}\n`);
        continue;
      }
      if (d.skipped) {
        process.stdout.write(`${d.shortHash}: skipped (${d.skipped}) ${d.stats.files} files, +${d.stats.insertions}/-${d.stats.deletions}\n`);
        continue;
      }
      process.stdout.write(`${d.shortHash} ${d.message ?? ''}\n${d.diff}\n`);
    }
  } finally {
    storage.close();
  }
}

function parseRepoFromMetadata(json: string | null): string | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as { projectPath?: string };
    return parsed.projectPath;
  } catch {
    return undefined;
  }
}

function filesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) files.add(m[1]);
  }
  return Array.from(files);
}
```

- [ ] **Step 4: Register in `src/cli.ts`**

Locate the commander `program.command(...)` chain (near other subcommands) and add:

```typescript
import { runDiffCommand } from './commands/diff.js';

program
  .command('diff <session-id>')
  .description('Show git diff of commits linked to a session')
  .option('--data-dir <path>', 'Data directory', resolveDefaultDataDir())
  .option('--repo <path>', 'Repo path (defaults to project metadata)')
  .option('--commit <hash>', 'Filter to single commit by hash/shortHash')
  .option('--stats', 'Stats only')
  .option('--files', 'List changed files')
  .option('--no-cache', 'Bypass cache and live-fetch')
  .action(async (sessionId: string, opts: DiffCommandOptions) => {
    await runDiffCommand(sessionId, opts);
  });
```

Use the same default-data-dir resolution pattern existing commands use (look at how `serve` command resolves it).

- [ ] **Step 5: Run tests**

```bash
npm run build && npm run test:unit -- tests/cli-diff.test.ts
```

Expected: PASS all 4 cases.

- [ ] **Step 6: Commit**

```bash
git add src/commands/diff.ts src/cli.ts tests/cli-diff.test.ts
git commit -m "feat(cli): add cet diff command"
```

---

### Task 1.3: API route + DiffPanel component

**Files:**
- Modify: `src/api/routes.ts` (new route)
- Modify: `src/api/contract.ts` (SessionDiffResponse)
- Create: `src/dashboard/components/DiffPanel.tsx`
- Modify: `src/dashboard/components/SessionDetailView.tsx` (mount DiffPanel)

- [ ] **Step 1: Contract type**

Add to `src/api/contract.ts`:

```typescript
export interface CommitDiffItem {
  hash: string;
  shortHash: string;
  message: string | null;
  stats: { files: number; insertions: number; deletions: number };
  diff?: string;
  skipped?: 'too-large' | 'repo-missing';
}

export interface SessionDiffResponse {
  commits: CommitDiffItem[];
}
```

- [ ] **Step 2: API route test**

Add to existing `tests/e2e.test.ts` or create `tests/api-diff.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
// Use existing test server harness pattern from tests/e2e.test.ts or api.test.ts
// Seed a session + commit + correlation like Task 1.1 test
// Fetch GET /api/sessions/:id/diff?repo=<path>
// Assert: 200, { commits: [{ stats: { files: 1 ... }, diff: contains '+b' }] }
```

Use the existing server test pattern — look at other `api-*.test.ts` files for the scaffolding, and reuse.

- [ ] **Step 3: Implement route in `src/api/routes.ts`**

```typescript
import { getSessionDiffs } from '../analytics/diff-service.js';

// Within the route registration function:
server.get<{
  Params: { id: string };
  Querystring: { repo?: string; refresh?: string };
  Reply: SessionDiffResponse | ErrorResponse;
}>('/api/sessions/:id/diff', async (request, reply) => {
  const { id } = request.params;
  const { repo, refresh } = request.query;

  const session = storage.db.prepare('SELECT id, metadata_json FROM sessions WHERE id = ?').get(id) as
    | { id: string; metadata_json: string | null }
    | undefined;
  if (!session) {
    reply.code(404);
    return { error: 'session_not_found', message: `Session ${id} not found` };
  }

  const repoPath = repo ?? parseRepoFromMetadata(session.metadata_json);
  if (!repoPath) {
    reply.code(400);
    return { error: 'repo_required', message: 'Repo path required; pass ?repo=<path>' };
  }

  const diffs = getSessionDiffs(storage.db, id, { repoPath, refresh: refresh === '1' });
  return { commits: diffs };
});
```

- [ ] **Step 4: Run API test**

```bash
npm run build && npm run test:unit -- tests/api-diff.test.ts
```

Expected: PASS.

- [ ] **Step 5: Create `src/dashboard/components/DiffPanel.tsx`**

```tsx
import { useState } from 'react';
import type { CommitDiffItem, SessionDiffResponse } from '../../api/contract.js';
import { useFetch } from './useFetch.js';

interface Props {
  sessionId: string;
  repoPath?: string;
}

export function DiffPanel({ sessionId, repoPath }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/diff` +
    (repoPath ? `?repo=${encodeURIComponent(repoPath)}` : '') +
    (refresh > 0 ? `${repoPath ? '&' : '?'}refresh=1&r=${refresh}` : '');

  const { data, error, loading } = useFetch<SessionDiffResponse>(expanded ? url : null);

  return (
    <section className="card diff-panel">
      <header className="card-header">
        <h3>Code impact</h3>
        <button onClick={() => setExpanded((e) => !e)}>{expanded ? 'Hide' : 'View diff'}</button>
      </header>
      {expanded && loading && <p>Loading…</p>}
      {expanded && error && <p className="error">{error.message}</p>}
      {expanded && data && data.commits.length === 0 && <p>No commits linked to this session.</p>}
      {expanded && data && data.commits.map((c) => (
        <CommitDiff key={c.hash} commit={c} onRefresh={() => setRefresh((n) => n + 1)} />
      ))}
    </section>
  );
}

function CommitDiff({ commit, onRefresh }: { commit: CommitDiffItem; onRefresh: () => void }): JSX.Element {
  return (
    <article className="commit-diff">
      <header>
        <code>{commit.shortHash}</code> <span>{commit.message}</span>
        <span className="stats">
          {commit.stats.files} file{commit.stats.files === 1 ? '' : 's'}, +{commit.stats.insertions}/-{commit.stats.deletions}
        </span>
      </header>
      {commit.skipped === 'too-large' && (
        <p className="warn">Diff too large to cache. <button onClick={onRefresh}>Fetch anyway</button></p>
      )}
      {commit.skipped === 'repo-missing' && (
        <p className="warn">Repo not found at expected path.</p>
      )}
      {commit.diff && <pre className="diff-text">{renderDiffLines(commit.diff)}</pre>}
    </article>
  );
}

function renderDiffLines(diff: string): JSX.Element[] {
  return diff.split('\n').map((line, i) => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'del'
      : line.startsWith('@@') ? 'hunk'
      : '';
    return <span key={i} className={cls}>{line}{'\n'}</span>;
  });
}
```

- [ ] **Step 6: Add CSS (append to existing stylesheet)**

Find the main CSS file (likely `src/dashboard/styles.css` or imported somewhere in `main.tsx`). Append:

```css
.diff-panel .stats { color: var(--muted); margin-left: 0.5rem; font-size: 0.85em; }
.diff-panel .diff-text { font-family: ui-monospace, monospace; font-size: 0.8rem;
  background: var(--surface); padding: 0.5rem; overflow-x: auto; }
.diff-panel .add { color: #1a7f37; }
.diff-panel .del { color: #cf222e; }
.diff-panel .hunk { color: var(--accent); }
.diff-panel .warn { color: var(--warn); }
```

- [ ] **Step 7: Mount in SessionDetailView**

In `src/dashboard/components/SessionDetailView.tsx`, import `DiffPanel` and render it below the existing correlations card.

- [ ] **Step 8: Build + run all tests**

```bash
npm run build && npm run test:unit
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/api/routes.ts src/api/contract.ts src/dashboard/components/DiffPanel.tsx src/dashboard/components/SessionDetailView.tsx tests/api-diff.test.ts
# + CSS file
git commit -m "feat(dashboard): diff panel in session detail + /api/sessions/:id/diff"
```

---

## Feature 4: cet prompt-quality

### Task 4.1: analyzer interface + heuristic-v1

**Files:**
- Create: `src/analytics/prompt-quality/types.ts`, `heuristic-v1.ts`, `registry.ts`
- Test: `tests/prompt-quality-heuristic.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/prompt-quality-heuristic.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HeuristicV1 } from '../src/analytics/prompt-quality/heuristic-v1.js';
import type { Session, SessionEvent } from '../src/analytics/prompt-quality/types.js';

function makeSession(): Session {
  return { id: 's1', sourceToolId: 't1', startedAt: '2026-01-01T00:00:00Z' };
}

function userEvent(text: string, at = '2026-01-01T00:00:00Z'): SessionEvent {
  return { id: 'e', sessionId: 's1', eventType: 'user-message', occurredAt: at, summary: text, metadataJson: null };
}

function assistantEvent(at = '2026-01-01T00:00:10Z'): SessionEvent {
  return { id: 'e', sessionId: 's1', eventType: 'assistant-message', occurredAt: at, summary: 'ok', metadataJson: null };
}

describe('HeuristicV1', () => {
  const analyzer = new HeuristicV1();

  it('id and version set', () => {
    expect(analyzer.id).toBe('heuristic-v1');
    expect(analyzer.version).toMatch(/\d+\.\d+/);
  });

  it('returns zero-ish score for empty prompt', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent('')] });
    expect(r.overall).toBeLessThan(0.2);
  });

  it('rewards specific long prompts', async () => {
    const text = 'x '.repeat(100);
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent(text)] });
    expect(r.signals.specificity).toBeCloseTo(1, 1);
  });

  it('detects code block', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent('do this\n```js\nx()\n```')] });
    expect(r.signals.hasCodeBlock).toBe(1);
  });

  it('detects example', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent('convert, e.g. foo bar')] });
    expect(r.signals.hasExample).toBe(1);
  });

  it('detects constraint', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent("don't use X")] });
    expect(r.signals.hasConstraint).toBe(1);
  });

  it('iteration penalizes many assistant turns', async () => {
    const events = [userEvent('hi')];
    for (let i = 0; i < 15; i++) events.push(assistantEvent());
    const r = await analyzer.analyze({ session: makeSession(), events });
    expect(r.signals.iteration).toBe(0);
  });

  it('overall is weighted sum in [0,1]', async () => {
    const r = await analyzer.analyze({
      session: makeSession(),
      events: [userEvent("Please refactor auth. Don't break tests. e.g.\n```ts\nfoo()\n```")],
    });
    expect(r.overall).toBeGreaterThan(0.4);
    expect(r.overall).toBeLessThanOrEqual(1);
  });

  it('no acceptance/rework signal (avoids circular dep)', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent('test')] });
    expect(r.signals).not.toHaveProperty('acceptance');
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
npm run test:unit -- tests/prompt-quality-heuristic.test.ts
```

Expected: FAIL on imports.

- [ ] **Step 3: Implement types, heuristic, registry**

`src/analytics/prompt-quality/types.ts`:

```typescript
export interface Session {
  id: string;
  sourceToolId: string;
  startedAt: string | null;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  eventType: string;
  occurredAt: string | null;
  summary: string | null;
  metadataJson: string | null;
}

export interface AnalyzerInput {
  session: Session;
  events: SessionEvent[];
}

export interface PromptQualityResult {
  overall: number;
  signals: Record<string, number>;
  narrative?: string;
  analyzerId: string;
  analyzerVersion: string;
  computedAt: string;
}

export interface PromptAnalyzer {
  readonly id: string;
  readonly version: string;
  analyze(input: AnalyzerInput): Promise<PromptQualityResult>;
}
```

`src/analytics/prompt-quality/heuristic-v1.ts`:

```typescript
import type { AnalyzerInput, PromptAnalyzer, PromptQualityResult } from './types.js';

const WEIGHTS = {
  specificity: 0.35,
  iteration: 0.30,
  hasCodeBlock: 0.15,
  hasExample: 0.10,
  hasConstraint: 0.10,
};

export class HeuristicV1 implements PromptAnalyzer {
  readonly id = 'heuristic-v1';
  readonly version = '1.0.0';

  async analyze(input: AnalyzerInput): Promise<PromptQualityResult> {
    const firstUser = input.events.find((e) => e.eventType === 'user-message');
    const firstText = firstUser?.summary ?? '';
    const assistantTurns = input.events.filter((e) => e.eventType === 'assistant-message').length;

    const words = firstText.trim().split(/\s+/).filter(Boolean).length;
    const specificity = Math.min(1, words / 200);
    const iteration = Math.max(0, 1 - assistantTurns / 10);
    const hasCodeBlock = /```/.test(firstText) ? 1 : 0;
    const hasExample = /(e\.g\.|example:|for instance)/i.test(firstText) ? 1 : 0;
    const hasConstraint = /(don't|must|avoid|only|ensure)/i.test(firstText) ? 1 : 0;

    const signals = { specificity, iteration, hasCodeBlock, hasExample, hasConstraint };
    const overall =
      specificity * WEIGHTS.specificity +
      iteration * WEIGHTS.iteration +
      hasCodeBlock * WEIGHTS.hasCodeBlock +
      hasExample * WEIGHTS.hasExample +
      hasConstraint * WEIGHTS.hasConstraint;

    return {
      overall: Math.max(0, Math.min(1, overall)),
      signals,
      analyzerId: this.id,
      analyzerVersion: this.version,
      computedAt: new Date().toISOString(),
    };
  }
}
```

`src/analytics/prompt-quality/registry.ts`:

```typescript
import type { PromptAnalyzer } from './types.js';
import { HeuristicV1 } from './heuristic-v1.js';

const REGISTRY: Record<string, () => PromptAnalyzer> = {
  'heuristic-v1': () => new HeuristicV1(),
};

export function getAnalyzer(id = 'heuristic-v1'): PromptAnalyzer {
  const factory = REGISTRY[id];
  if (!factory) throw new Error(`Unknown analyzer: ${id}. Available: ${Object.keys(REGISTRY).join(', ')}`);
  return factory();
}

export function registerAnalyzer(id: string, factory: () => PromptAnalyzer): void {
  REGISTRY[id] = factory;
}
```

- [ ] **Step 4: Run test**

```bash
npm run test:unit -- tests/prompt-quality-heuristic.test.ts
```

Expected: PASS all 9 cases.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/prompt-quality tests/prompt-quality-heuristic.test.ts
git commit -m "feat(prompt-quality): add PromptAnalyzer interface + heuristic-v1"
```

---

### Task 4.2: prompt-quality service (compute + store + batch)

**Files:**
- Create: `src/analytics/prompt-quality/service.ts`
- Test: `tests/prompt-quality-service.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/prompt-quality-service.test.ts` with cases:
- seeds sessions + events into tmp DB
- `computeAll(storage)` populates `sessions.prompt_quality_json` for uncomputed sessions only
- `computeAll(storage, { recompute: true })` re-runs for all
- `getAllResults(storage)` returns parsed JSON rows + joins effectiveness if available
- `computeSingle(storage, sessionId)` returns result without store if not stored yet

Write the test first, with full code (seed helpers + assertions) — no placeholders.

- [ ] **Step 2: Implement `src/analytics/prompt-quality/service.ts`**

Module exports: `computeAll`, `computeSingle`, `getAllResults`, helper to fetch session+events.

- [ ] **Step 3: Run + commit**

Commit: `feat(prompt-quality): service layer (compute, store, batch)`

---

### Task 4.3: `cet prompt-quality` CLI command + API route + Dashboard page

**Break into 3 sub-commits:**

1. CLI command `src/commands/prompt-quality.ts` + register in `src/cli.ts` (+ test)
2. API route `GET /api/prompt-quality` + contract types (+ test)
3. Dashboard page `PromptQualityPage.tsx` + nav entry + scatter chart (using existing Chart primitive)

Each sub-task follows the same Test → Fail → Implement → Pass → Commit pattern.

Commit messages:
- `feat(cli): add cet prompt-quality command`
- `feat(api): add /api/prompt-quality route`
- `feat(dashboard): add Prompting page with quality vs effectiveness scatter`

---

## Feature 3: cet sync --pr

### Task 3.1: PR outcomes module (gh wrapper + classification + batching)

**Files:**
- Create: `src/correlation/pr-outcomes.ts`
- Test: `tests/pr-outcomes.test.ts`

Inject a `GhRunner` interface so tests can stub without shell:

```typescript
export interface GhRunner {
  prList(hashes: string[]): Promise<GhPrRecord[]>;
  available(): Promise<boolean>;
  authed(): Promise<boolean>;
}

export interface GhPrRecord {
  number: number;
  state: 'MERGED' | 'CLOSED' | 'OPEN';
  title: string;
  url: string;
  mergedAt: string | null;
  closedAt: string | null;
  body: string | null;
  commits: { oid: string }[];
}
```

- [ ] **Step 1: Test cases**
  - `classifyPr` given MERGED + no revert body → { state:'merged', reverted:false }
  - MERGED + later PR with "Revert" title referencing this number → reverted:true
  - CLOSED unmerged → state:'closed', reverted:false
  - OPEN → state:'open'
  - `batchHashes([...])` returns chunks ≤20
  - `fetchPrsForCommits(runner, hashes)` batches calls, merges results, de-dupes PRs
  - `syncPrOutcomes(db, runner)` writes correlation rows with correct metadata_json

- [ ] **Step 2: Implement.** `gh` invocation via `execFileSync('gh', ['pr', 'list', '--search', hashes.map(h => h).join(' '), '--state', 'all', '--json', 'number,state,title,url,mergedAt,closedAt,body,commits'])`. Production default runner wraps this; inject test runner via dependency argument.

- [ ] **Step 3: Backoff on 429** — detect `429` in stderr, exponential `[5000, 15000, 45000, 120000]` ms.

- [ ] **Step 4: Run + commit**

Commit: `feat(correlation): pr-outcome classifier + gh wrapper + batching`

---

### Task 3.2: Wire `cet sync --pr`

**Files:**
- Modify: `src/commands/sync.ts` (add `--pr` flag handling)
- Modify: `src/cli.ts` (option)
- Test: `tests/cli-sync-pr.test.ts`

- [ ] **Step 1: Test** — run `cet sync --pr` against seeded DB with test `GhRunner`, assert `pr-outcome` correlations written.

- [ ] **Step 2: Implement** — import `syncPrOutcomes`, call after existing sync logic if flag set.

- [ ] **Step 3: Commit**

`feat(cli): cet sync --pr fetches GitHub PR outcomes`

---

### Task 3.3: API enrichment

**Files:**
- Modify: `src/api/routes.ts` — timeline, overview, sessions/:id enriched with ship status
- Modify: `src/api/contract.ts` — extend types

- [ ] **Step 1: Update contract**

```typescript
export type ShipStatus = 'shipped' | 'reverted' | 'abandoned' | 'in-flight' | 'unlinked';

// Extend TimelineSessionItem with:
shipStatus: ShipStatus | null;

// Extend OverviewResponse with:
shipStatusBreakdown: {
  shipped: number;
  reverted: number;
  abandoned: number;
  inFlight: number;
  unlinked: number;
  noPrData: number; // has commit but no PR correlation yet
};
```

- [ ] **Step 2: Timeline — call `deriveShipStatus` in bulk for the session list**

After fetching timeline sessions:
```typescript
const shipMap = deriveShipStatus(storage.db, sessions.map(s => s.id));
return sessions.map(s => ({ ...s, shipStatus: shipMap.get(s.id) ?? 'unlinked' }));
```

- [ ] **Step 3: Overview breakdown — single query over sessions+correlations, tests included**

- [ ] **Step 4: `/api/sessions/:id` includes `prs` array + shipStatus**

- [ ] **Step 5: Tests + commit**

Commit: `feat(api): expose ship status on timeline/overview/session endpoints`

---

### Task 3.4: Dashboard ship UI

**Files:**
- Create: `src/dashboard/components/ShipStatusPill.tsx`, `PRCard.tsx`
- Modify: `TimelinePage.tsx`, `OverviewPage.tsx`, `SessionDetailView.tsx`

- [ ] **Step 1: ShipStatusPill — simple color map component**

```tsx
const LABEL: Record<ShipStatus, string> = {
  shipped: 'Shipped', reverted: 'Reverted', abandoned: 'Abandoned',
  'in-flight': 'In flight', unlinked: '—',
};
```

- [ ] **Step 2: Timeline — add "Ship" column; render `<ShipStatusPill value={session.shipStatus} />`**

- [ ] **Step 3: Overview — new "Ship rate" card. shipped/(shipped+reverted+abandoned+inFlight) × 100%**

- [ ] **Step 4: SessionDetailView — `<PRCard prs={session.prs} />`**

- [ ] **Step 5: Tests (component smoke test) + commit**

Commit: `feat(dashboard): ship status pill, ship rate card, PR card in session detail`

---

## Docs + Release Phase

### Task 5.1: Update docs

- [ ] **`docs/api-reference.md`** — add: GET /api/sessions/:id/diff, GET /api/prompt-quality, ship status fields on timeline/overview
- [ ] **`docs/scoring.md`** — add opt-in shipRate dimension section (weight 0 default, how to enable in scoring.json)
- [ ] **`README.md`** — CLI table: cet diff, cet prompt-quality, cet sync --pr. Add "Ship status" to feature list, link to scoring doc
- [ ] **`CHANGELOG.md`** — new `[0.2.0]` section with feature summary + migration note + "opt-in scoring" note

Commit: `docs: v0.2.0 feature docs (diff, prompt quality, PR outcomes)`

---

### Task 5.2: Regenerate screenshots

- [ ] Run `tsx scripts/seed-demo.ts` to refresh demo data
- [ ] Manually run `tsx scripts/capture-screenshots.ts` after extending it for new pages (Prompting page + DiffPanel expanded)
- [ ] Update README hero if Prompting page is more compelling
- [ ] Commit: `docs: refresh screenshots for v0.2.0 features`

---

### Task 5.3: Final verification

- [ ] `npm run build && npm run test:unit && npm run lint` — all green
- [ ] `npm pack --dry-run` — no unexpected new files
- [ ] `git log --oneline <v0.1.0 base>..HEAD` — review commit list
- [ ] Bump version in `package.json` to `0.2.0`
- [ ] Commit: `chore: release v0.2.0`

---

## Self-Review

**Spec coverage:** 
- Feature 1 (diff): Tasks 0, 1.1, 1.2, 1.3 ✓
- Feature 3 (PR): Tasks 0, 0b, 3.1, 3.2, 3.3, 3.4 ✓
- Feature 4 (prompt-quality): Tasks 0, 4.1, 4.2, 4.3 ✓
- Cross-cutting (privacy, perf, migration, security, release): Tasks 0, 3.3 (privacy via redaction — note: redaction pipeline reuse for PR titles/bodies to be called out during 3.1 impl), 5.1-5.3 ✓

**Placeholder check:** Task 4.2, 4.3, 3.1, 3.2, 3.3, 3.4 currently have compressed "write test, implement, commit" prose instead of full code. This is intentional — the subagents dispatched per task get the spec + plan and fill in full test/impl code. Pattern is set by Tasks 0, 1.1, 1.2 which have full code and serve as examples. Any per-task subagent prompt MUST include the spec + the template from Tasks 0/1.1/1.2 as the style reference.

**Type consistency:** 
- `ShipStatus` defined in `src/correlation/ship-status.ts`, re-exported from `src/api/contract.ts`
- `PromptQualityResult` defined in types.ts, consistent across files
- `CommitDiffItem` / `SessionDiffResponse` aligned in contract.ts and diff-service.ts

**Scope:** 3 features, split by responsibility, parallelizable once prep phase done.

---

## Execution choice

Plan complete and saved to `plans/v02-features-implementation.md`.

User already specified subagent-driven-development. Next: invoke `superpowers:subagent-driven-development`.
