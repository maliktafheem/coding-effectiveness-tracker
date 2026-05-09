# Launch-Ready Design

Date: 2026-05-09
Scope: All blockers + polish from honest review
Approach: TDD per fix, one commit each
Publish: No — ready repo only

## Goal

Make coding-effectiveness-tracker publish-ready without publishing. Fix correctness issues, eliminate hot-path N+1 queries, document privacy limitations honestly, verify CI + pack, and tighten dashboard/API contract.

## In-Scope Fixes

Ordered by risk first, then polish.

### F1 — Project identity fallback collision (correctness)

**Problem.** `claude-code.ts:186`, `codex.ts:193`, `opencode.ts:190` set `projectId = cwd.split(/[/\\]/).pop()?.toLowerCase()`. Registry overrides this via `deriveProjectId(projectPath)` when `metadata.projectPath` set. Fallback survives when projectPath missing → two repos named `api` merge.

**Fix.** Registry becomes authoritative. Importers stop setting `projectId` directly. Session.projectId remains null unless registry derives stable id from projectPath. Session still links to default project via existing code.

**Tests.** Add cross-path collision test: two sessions with `/home/a/api` and `/home/b/api` produce distinct `projectId`s. Test session with no cwd metadata stays unlinked or links to default, never collides.

### F2 — N+1 correlation queries in scoring (perf)

**Problem.** `effectiveness.ts:164-168` and `:261-264` run `SELECT count(*) FROM correlations WHERE session_id = ? AND correlation_type = ?` once per session. At 10k sessions, that is 20k prepared statement runs per score computation.

**Fix.** Single aggregate: `SELECT session_id, correlation_type, COUNT(*) AS cnt FROM correlations WHERE session_id IN (?, ?, ...) AND correlation_type IN ('git-commit', 'test-outcome') GROUP BY session_id, correlation_type`. Build `Map<sessionId, Set<type>>`, read per session in memory. Two aggregate queries replace 2×N.

**Tests.** Existing scoring tests must still pass. Add perf-shaped test: 500 sessions, 2000 correlations, score computes <100ms.

### F3 — Privacy redaction limitations documented (honesty)

**Problem.** `redactSecrets` is regex blocklist. Docs/privacy.md reads like guarantees. Users exporting summaries may assume stronger redaction than actually exists.

**Fix.** Add "Limitations and Known Gaps" section to docs/privacy.md enumerating:
- Blocklist nature — patterns must be known in advance
- Novel/custom secret formats not matched
- High-entropy opaque strings without known prefix slip through
- `metadata_json` may contain tool-specific fields not in sensitive-key list
- Recommendation: inspect exports before sharing, never export `raw=true` without review

Also add "Reporting a redaction gap" pointer to SECURITY.md.

### F4 — Rework dim JSON extraction (perf + correctness)

**Problem.** `effectiveness.ts:364-376` reads `metadata_json` per session, runs `JSON.parse` in loop. Fails silently on malformed JSON.

**Fix.** Use SQLite `json_extract(metadata_json, '$.reworkCount')` in aggregate query. Single query returns sum + count. Fails loudly on malformed JSON via CHECK or caller log.

**Tests.** Existing rework tests pass. Add test for malformed `metadata_json` — dim reports `available: false` instead of silently returning 1.

### F5 — Dashboard/API type contract (drift)

**Problem.** `src/dashboard/components/types.ts` duplicates API response shapes. No shared contract → silent drift.

**Fix.** Extract shared API response types to `src/api/contract.ts`. Dashboard imports from contract via `src/dashboard/components/types.ts` re-export. Routes return typed responses matching contract. Any route that constructs responses gets return type annotated.

**Tests.** `tsc --noEmit` catches drift at compile time. No runtime tests needed — type system enforces.

### F6 — CI badge verification (release correctness)

**Problem.** README badge points at `ci.yml`. Badge may render "no status" if no run exists on default branch.

**Fix.** Confirm workflow has run on master. Trigger a manual run if needed (`gh workflow run`). If badge still wrong, swap badge URL or branch reference.

**Tests.** `gh run list --workflow=ci.yml --limit 1` returns a green run.

### F7 — CHANGELOG 0.1.0 entry (release hygiene)

**Problem.** `CHANGELOG.md` exists but may not reflect launch feature set.

**Fix.** Ensure 0.1.0 section covers: importers (Claude Code, Codex, OpenCode, Cursor, Factory Droid), CLI commands, dashboard, privacy model, scoring engine. Move current in-progress work under `[Unreleased]` if present.

### F8 — Pack contents sanity (release correctness)

**Problem.** `npm pack --dry-run` currently ships 182 files, 308kB. Includes `docs/assets/*.png` (123kB). Verify no stray files.

**Fix.** Review pack list. Add `.npmignore` or tune `"files"` if anything unwanted lands in tarball. Keep dashboard assets (`dist/dashboard/**`) — required at runtime.

### F9 — Architecture doc drift (docs correctness)

**Problem.** `docs/architecture.md` diagram lists 9 endpoints; real count is 14 (includes `/api/trends`, `/api/available-tools`, `/api/sessions/:id`, annotation POST/PATCH). README lists 13.

**Fix.** Regenerate endpoint list from `src/api/routes.ts` registration order. Sync diagram + tables. Apply same treatment to importer list (Factory Droid, Cursor both shown).

### F10 — TrendChart duplication risk (polish)

**Problem.** `TrendChart.tsx` is 200 lines hand-rolled SVG. Second chart = copy-paste disaster.

**Fix.** Extract `Chart.tsx` with props `{ points, series, formatX, formatY }` covering the two axis rendering + animation primitives. TrendChart becomes a thin call site. No lib added — keep zero-dep.

**Tests.** Visual regression via dashboard build — render test not worth the setup cost. Rely on reviewer eyes.

## Non-Goals

- No npm publish this pass.
- No new importers.
- No new score dimensions.
- No dashboard feature additions.
- No migration of existing DBs — schema unchanged by F1–F10.

## Execution Shape

TDD per fix. Each fix = one commit. Order:

1. F1 — identity fallback (correctness, isolated)
2. F2 — N+1 query (perf, isolated)
3. F4 — rework JSON extract (perf, touches F2 territory)
4. F3 — privacy docs (no code)
5. F5 — API contract (touches dashboard, API)
6. F9 — architecture doc sync
7. F10 — Chart extraction
8. F6, F7, F8 — release hygiene, final pass

Each commit: `test: …` → `fix: …` or `fix: …` with test in same commit (scoring perf tests too expensive to split).

## Parallelism

Dispatch sonnet subagents for independent work units:
- F1 + F2 + F3 + F4 can run in parallel (no file overlap beyond tests)
- F5, F9, F10 serial after F1–F4 (touches shared surface)
- F6–F8 final sequential sweep

## Verification Gates

After every commit: `npm run build && npm run typecheck && npm run lint && npm test`. Final gate: `npm pack --dry-run` clean.

## Risks

- **Scoring test flake on perf test.** Keep threshold generous (200ms), or drop perf assertion if env-dependent.
- **Importer tests may encode naive projectId assumption.** Fix assertions when found; do not weaken intent.
- **CI badge fix may need push to master.** Confirm before triggering workflow.
