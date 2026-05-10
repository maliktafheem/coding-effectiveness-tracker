# v0.2.0 Features Design — Diff View, PR Outcomes, Prompt Quality

**Status:** Approved by user 2026-05-10. Ready for implementation planning.
**Base:** c64e090 (post–v0.1.1 fixes)

## Summary

Three additive features targeting "does AI-assisted code actually ship and was it well-prompted":

1. **`cet diff`** — surface real code diffs from session-linked commits
2. **`cet sync --pr`** — correlate commits to GitHub PRs (shipped / reverted / abandoned)
3. **`cet prompt-quality`** — heuristic score of prompt quality with extension point for future LLM analyzers

All three ship as CLI + Dashboard. No breaking changes. Migration adds one table + one column.

## Architecture

```
┌─ cet diff <session-id> ──────────────┐     ┌─ cet sync --pr ─────────────┐
│ git diff <parent>..<commit>          │     │ gh pr list --search <hash>  │
│ cache per-commit (≤100 KB)           │     │ create pr-outcome corr      │
│ render ANSI (CLI) / HTML (web)       │     │ (no redundant column)       │
└──────────────┬───────────────────────┘     └──────────┬──────────────────┘
               │                                         │
               ▼                                         ▼
     /api/sessions/:id/diff          /api/sessions/:id ← joins correlations
     DiffPanel in SessionDetailView  Timeline ship pill + Overview ship-rate card

┌─ cet prompt-quality ────────────────────────────────────┐
│ read events.summary → heuristic signals (sync)          │
│ PromptAnalyzer interface: async for future LLM          │
│ score 0-1 stored in sessions.prompt_quality_json        │
└──────────────┬──────────────────────────────────────────┘
               ▼
     /api/prompt-quality → new PromptQualityPage
```

## Data Model

**New table** (migration `002_v02_features.sql`):

```sql
CREATE TABLE session_diffs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  diff_text TEXT,                  -- NULL when skipped
  stats_json TEXT NOT NULL,        -- { files, insertions, deletions }
  cached_at INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  skipped_reason TEXT,             -- 'too-large' | 'repo-missing' | NULL
  UNIQUE(session_id, commit_hash)
);
CREATE INDEX idx_session_diffs_session ON session_diffs(session_id);

-- Prompt quality on sessions (one column, JSON-shaped)
ALTER TABLE sessions ADD COLUMN prompt_quality_json TEXT;
```

**No `ship_status` column.** Ship status derived from correlations:

```sql
SELECT session_id,
       CASE
         WHEN EXISTS (SELECT 1 FROM correlations c
                      WHERE c.session_id = s.id
                      AND c.correlation_type = 'pr-outcome'
                      AND json_extract(c.metadata_json, '$.state') = 'merged'
                      AND json_extract(c.metadata_json, '$.reverted') = 0)
           THEN 'shipped'
         -- etc.
       END AS ship_status
FROM sessions s;
```

Rationale: single source of truth. Correlations table already indexed on session_id. Add helper in `src/storage/ship-status.ts` to centralize query.

## Feature 1: `cet diff`

### CLI

```
cet diff <session-id>              # Full diff, ANSI if TTY
cet diff <session-id> --stats      # "3 files, +147/-22"
cet diff <session-id> --files      # List changed files
cet diff <session-id> --no-cache   # Skip cache, live fetch
cet diff <session-id> --commit <hash>  # One specific commit if session has multiple
```

### Size policy

**Per commit** cap: 100 KB of diff text. If exceeded:
- `skipped_reason='too-large'`
- `diff_text=NULL`, `stats_json` still populated
- Live-fetch when viewed; warn in UI

Per session total: unbounded (many small commits OK).

### API

```
GET /api/sessions/:id/diff
GET /api/sessions/:id/diff?refresh=1    # Force live fetch, update cache
Response: { commits: [{ hash, shortHash, message, diff?, stats, skipped? }] }
```

### Dashboard

New `<DiffPanel>` in `SessionDetailView`:
- Collapsed by default → "3 files changed, +147/-22 [View diff]"
- Expand → simple regex-based red/green line rendering (no heavy syntax lib)
- Multi-commit → dropdown selector
- Copy to clipboard button
- Warn banner if `skipped_reason` present

### Tests

- Unit: diff-service returns stats + text for small diff, stats only for large
- Unit: cache hit bypasses git exec (mock timer)
- Unit: repo-missing error message actionable
- Integration: full flow session → API → DiffPanel rendered (vitest + tmp git repo)
- E2E: Playwright (mark skip on Windows CI unless `PLAYWRIGHT_ALL=1`)

## Feature 3: `cet sync --pr`

### CLI

```
cet sync              # Existing, unchanged
cet sync --pr         # Opt-in PR fetch
cet sync --pr --repo <path>    # Explicit repo
cet sync --pr --since <date>   # Only fetch PRs touching commits since date
```

### Behavior

1. Select commits linked to sessions via existing git-commit correlations.
2. Batch up to 20 hashes per `gh pr list --search "<h1> OR <h2> OR..." --state all --json number,state,title,url,mergedAt,closedAt,body`.
3. Classify each matched PR:
   - `state=MERGED` → shipped (unless reverted)
   - `state=CLOSED` (unmerged) → abandoned
   - `state=OPEN` → in-flight
4. Revert detection (best-effort):
   - Look for subsequent PRs whose body mentions `#<orig-pr-num>` and title matches `/^Revert /i`
   - OR commits in `git log` matching `/Revert "<orig-commit-msg>"/` reachable from HEAD
   - Set `metadata.reverted=true` when either found
5. Write correlation row per matched PR: `correlation_type='pr-outcome'`, `target_id=<pr-number>`, metadata_json=full classification payload.
6. Errors:
   - `gh` missing → clear message with install link
   - `gh auth` missing → message with `gh auth login` command
   - Rate limit 429 → exponential backoff (5s, 15s, 45s, 120s max)

### API

Existing endpoints gain computed `shipStatus` field:
- `GET /api/timeline` → each session has `shipStatus: 'shipped' | 'reverted' | 'abandoned' | 'in-flight' | 'unlinked' | null`
- `GET /api/sessions/:id` → same field + `prs: [{ number, state, title, url }]`
- `GET /api/overview` → `shipStatusBreakdown: { shipped, reverted, abandoned, inFlight, unlinked }`

### Dashboard

- **Timeline** new column "Ship" with colored pill:
  - green = shipped
  - red = reverted
  - gray = abandoned
  - yellow = in-flight
  - — = unlinked or no commits
- **Overview** new "Ship rate" card: `<shipped count> / <sessions-with-commits>` with sparkline
- **SessionDetailView** new PR card: list linked PRs with state badges + links (click → opens in browser)

### Scoring (opt-in, v0.2 does NOT enable by default)

Document `shipRate` as 7th dimension in `docs/scoring.md`:
```json
{
  "weights": { ..., "shipRate": 0.10 }
}
```
Must user-opt-in via `scoring.json`. Default weight 0.

### Tests

- Unit: classifier given mock `gh` JSON produces correct status per state
- Unit: revert detection with PR body fixtures + git log fixtures
- Unit: batch builder caps at 20 hashes
- Unit: backoff timer respects exponential schedule
- Integration: `sync --pr` with PATH-shimmed fake `gh` binary → expected correlations
- Graceful: missing gh → exit code 1, message tested

## Feature 4: `cet prompt-quality`

### Interface

```typescript
// src/analytics/prompt-quality/analyzer.ts
export interface PromptAnalyzer {
  readonly id: string;         // 'heuristic-v1', 'llm-anthropic-v1'
  readonly version: string;
  analyze(input: AnalyzerInput): Promise<PromptQualityResult>;
}

export interface AnalyzerInput {
  session: Session;
  events: SessionEvent[];      // sorted by occurredAt
}

export interface PromptQualityResult {
  overall: number;             // 0..1
  signals: Record<string, number>;
  narrative?: string;          // optional short explanation
  analyzerId: string;
  analyzerVersion: string;
  computedAt: string;          // ISO
}
```

Interface is `Promise<T>` so future LLM analyzers slot in without refactor.

### Heuristic v1 signals (sync, wrapped in Promise.resolve)

| Signal | Computation | Weight |
|---|---|---|
| `specificity` | min(1, wordCount(firstPrompt) / 200) | 0.35 |
| `iteration` | max(0, 1 − assistantTurns/10) | 0.30 |
| `hasCodeBlock` | 1 if /```/ in firstPrompt else 0 | 0.15 |
| `hasExample` | 1 if /(e\.g\.\|example:\|for instance)/i in firstPrompt else 0 | 0.10 |
| `hasConstraint` | 1 if /(don't\|must\|avoid\|only\|ensure)/i in firstPrompt else 0 | 0.10 |

Overall = weighted sum.

**NO `acceptance` signal.** Removes circular dependency with rework dimension.

### CLI

```
cet prompt-quality                     # Compute all uncomputed sessions, print summary
cet prompt-quality --session <id>      # One detail
cet prompt-quality --recompute         # Force recompute all
cet prompt-quality --top 10            # Best prompts
cet prompt-quality --worst 10          # Worst prompts
cet prompt-quality --analyzer <id>     # Pick analyzer (default heuristic-v1)
```

### API

```
GET /api/prompt-quality
  → { sessions: [{ id, overall, signals, toolId, startedAt, effectivenessScore? }],
      avgOverall, analyzer: 'heuristic-v1' }
GET /api/sessions/:id → includes promptQuality field
```

### Dashboard

New nav link "Prompting" → `PromptQualityPage`:
- Summary card: avg quality score, distribution histogram
- Scatter: prompt quality (x) × session effectiveness (y) — reveals correlation
- Table: top 10 + bottom 10 with prompt preview (first 120 chars, redacted) + signals breakdown

`SessionDetailView`: small bar chart of signal breakdown.

### Tests

- Unit: heuristic analyzer on fixtures (strong/weak/code-block/example/constraint prompts)
- Unit: analyzer interface contract (register alt analyzer, dispatch by id)
- Unit: skip already-computed unless --recompute
- Integration: compute → store → API → page renders
- E2E: navigate Prompting page, see chart (skip on Windows CI)

## Cross-cutting

### Privacy

- Diffs: live-by-default respected via `--no-cache`; cached diff text lives in DB → apply redaction pipeline before store.
- PR titles/bodies: same redaction.
- Prompt quality: stores numeric signals + short narrative only. Raw prompt text NOT stored beyond existing event records.

### Perf

- Diff cache interactive viewing <50ms after first hit
- `sync --pr` batches 20 commits per gh call, 5 concurrent, exponential backoff on 429
- Heuristic prompt-quality: ~2ms/session; 1000 sessions in <2s
- Skip already-computed sessions by default

### Security

- All git/gh exec via `execFileSync`/`spawn` with array args (no shell interpolation)
- User-provided `--repo` path resolved via `path.resolve` + verified as inside a git repo before use
- `gh` output JSON parsed with schema validation (zod or manual)

### Migrations

- Check current migration scheme at `src/storage/migrations/` (likely `001_core_schema.sql`)
- New file `002_v02_features.sql` runs on `cet init` or first `cet` command against existing DB
- ALTER TABLE for `prompt_quality_json` is safe (nullable column)
- CREATE TABLE `session_diffs` additive

### Build order (for subagent dispatch)

1. **Prep** — migration 002, helper `src/storage/ship-status.ts`
2. **Feature 1 (diff)** — most isolated, builds confidence
3. **Feature 4 (prompt-quality)** — independent
4. **Feature 3 (PR)** — depends on gh CLI integration + ship-status helper; touches Timeline/Overview/SessionDetail

Each feature = separate subagent task. Code review gate between each. Commit per logical unit.

### CI / release

- Keep branches threshold ≥60 (fixes #5 already did)
- All new files covered by tests
- `npm run build && npm run test:unit && npm run lint` green before tagging v0.2.0
- Update CHANGELOG.md with v0.2.0 section
- Update README CLI table with 3 new commands
- Update `docs/api-reference.md` with new endpoints
- Update `docs/scoring.md` with opt-in shipRate dim

## Out of scope (v0.2)

- GitLab/Bitbucket support (GitHub only)
- LLM-based prompt analyzer (extension point only, no impl)
- Automatic `shipRate` scoring (opt-in documented, weight=0 default)
- Visual regression testing via screenshots
- Rebase-proof diff cache invalidation (commit hash assumed immutable post-push)
