# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-11

### Security & Privacy

- **Privacy (blocker)**: redact secrets at every read boundary — annotation notes on `/api/sessions/:id`, `/api/sessions/:id/annotations` POST/PATCH, `/api/export/{json,markdown}`, `cet report --json`, and `cet annotate` terminal echo. Defence-in-depth covers legacy rows persisted before this fix.
- **Symlink containment**: `safeReadDir` now realpath-checks `dirPath` itself and every directory-like subentry before descent. Junctions that escape root are rejected or skipped.
- **Cross-origin**: `onRequest` guard blocks all methods for hostile `Origin`, not just writes. GET `/api/sessions/:id/diff` (side-effecting) can no longer be triggered from a malicious page.
- **Plugin opt-in**: importer plugins under `<dataDir>/importers/plugins/` are no longer auto-loaded. Require `--enable-plugins` on `cet import`. Warning printed when enabled.
- **Packaging**: `.map` and `.d.ts.map` excluded from published tarball; CI `pack-smoke` job installs the packed tarball and runs `cet --version`/`init`/`report` plus a dashboard-asset and source-map leak check.

### Scoring model changes (trust the number)

- **Aggregate gate**: composite score now uses total-weight denominator (missing dimensions contribute 0 to numerator, not removed from denominator). Exposes `dataCompleteness` + `evidenceLevel` (`insufficient` / `partial` / `strong`). Insufficient-evidence banner + pill in dashboard, "Evidence: …" line in CLI + markdown export.
- **Confidence-weighted coverage**: git and test dimensions skip correlations below `0.3` confidence and credit `min(maxConfidence, 1)` per qualifying session.
- **Test-confidence session-scoped**: `test-outcomes` linked via `session_id` or `correlations.type='test-outcome'`. Project-wide pass rate no longer inflates unrelated session scores.
- **Branch-bonus gate**: +0.1 correlation bonus only fires on non-default branches (`master`/`main`/`develop`/`trunk` excluded).
- **Config centralization**: `src/scoring/score-service.ts` is the single entry point. API, CLI, and trends analytics all go through it — surfaces agree on weights + thresholds.

### Correlation changes

- `cet sync` re-correlation preserves `pr-outcome` rows (only clears engine-owned types: `git-commit`, `test-outcome`, `manual-outcome`).
- PR correlation metadata updates on any field diff, not just `state`. Revert flips no longer silently lost.

### API

- Error handler: 4xx returns real `{ error: name, message }`. 5xx returns sanitized `{ error: 'Internal server error' }` only (no internal detail leak).
- Exports pass server `dataDir` to `generateJsonExport` / `generateMarkdownExport` so scoring config matches overview.

### CLI

- `cet test-outcome` inputs validated by Zod (nonneg ints, ISO datetimes) in inline + `--outcome-json` modes.
- `cet test -- npm test` resolves `.cmd` shims on Windows via `spawnSafe` without shell interpolation. Path arguments and already-suffixed commands pass through unchanged.

## [0.2.1] - 2026-05-11

### Fixed

- **Dashboard**: TrendChart legend ("Effectiveness Score" / "Session Volume") no longer clipped. Bumped top padding 28→44 and repositioned legend so the full text renders above the plot area.
- **Screenshots**: `scripts/capture-screenshots.ts` now disables CSS animations via `addInitScript` so captures land in the settled state (not mid-`fadeSlideRight`). Overview restored to `fullPage: true` so Score Dimensions + Period card are visible below the fold.

## [0.2.0] - 2026-05-10

### Added

- **`cet diff <session-id>`** — show git diff of commits linked to a session. Per-commit 100KB cache, live-fetch with `--no-cache`. Inline DiffPanel in dashboard session detail.
- **`cet prompt-quality`** — score prompts by specificity, iteration, code blocks, examples, constraints. Pluggable `PromptAnalyzer` interface supports future LLM analyzers. New Prompting dashboard page.
- **`cet sync --pr`** — fetch GitHub PR outcomes (requires `gh` CLI). Classifies sessions as shipped/reverted/abandoned/in-flight. Ship status pill in Timeline, ship-rate card in Overview, PR card in session detail.
- **Ship status API** — `/api/timeline`, `/api/overview`, `/api/sessions/:id` now surface ship status derived from correlations.
- **Prompt quality API** — `GET /api/prompt-quality` returns all scored sessions.

### Changed

- Migration 002 adds `session_diffs` table + `prompt_quality_json` column.
- Migration 003 adds `ON DELETE CASCADE` to `session_diffs.session_id` FK.
- Storage now enables `PRAGMA foreign_keys = ON` (logs warning on pre-existing violations).
- `diff-service` consolidates two `git show` calls into one for ~2x perf on diff fetch.
- `useFetch` hook now skips fetch when URL is empty/null (was wasting requests).

### Docs

- API reference documents new endpoints and response shapes.
- Scoring doc explains opt-in ship rate dimension and prompt quality.

## [Unreleased]

### Added

- **Dashboard**: Effectiveness trends chart on Overview page (SVG, zero-dep).
- **CLI**: `cet tag` command for session tagging and filtering.
- **CLI**: `cet compare` command for per-tool and per-period comparisons.
- **CLI**: `cet watch` background daemon for polling new sessions and git changes.
- **Analytics**: `/api/trends` weekly rolling analytics endpoint.
- **Dashboard**: Dynamic tool dropdown driven by imported data.
- **Scoring**: Configurable weights and thresholds via `scoring.json` in the data directory.
- **Correlation**: Branch-aware confidence bonus when a session's commits share one branch.
- **Plugins**: Importer registration docs and external plugin pattern.

### Changed

- **Importers**: Registry is now authoritative for project identity derivation. Importers no longer set `session.projectId` directly; the registry calls `deriveProjectId(projectPath)` when `metadata.projectPath` is present, preventing collisions between unrelated repositories that share a folder name.
- **Docs**: `docs/privacy.md` now documents redaction pipeline limitations explicitly (blocklist scope, novel formats, high-entropy free text, `raw=true` export warning).

### Fixed

- **Packaging**: Exclude `docs/assets/.demo-data/` (dev scratch tracker.db + scoring.json, ~176 KB) from the published npm tarball via `files` negations and `.npmignore`.

## [0.1.0] - 2026-05-07

### Added

- **Initial project foundation**: TypeScript project with Commander CLI, SQLite storage, and core schema ([6f92585])
- **Importer framework**: Tool importers for Codex, OpenCode, Claude Code, Cursor, and Factory Droid with `cet import` command ([d0c3ba4])
- **Correlation engine**: Git/test/manual outcome collection, confidence-scored correlation, balanced effectiveness scoring, project filtering, date filtering, cost/token capture, rework indicators, and report/annotate CLI commands ([c787e7e])
- **CLI sync and test-outcome commands**: `cet sync` for local Git commit correlation and `cet test-outcome` for test result ingestion ([1e686c6])
- **Dashboard and API**: Fastify local API and Vite/React dashboard with annotations and exports ([a4c895c])
- **E2E smoke test**: Fresh Windows PowerShell checkout journey verification (VAL-INSTALL-001) ([840dbce])
- **Documentation**: Public release design document ([6e897a9])
- **Complete docs/ folder**: 8 reference files covering architecture, development, CLI reference, API reference, data model, importer guide, and privacy ([4a83a15])

### Fixed

- **Foundation**: Recover from corrupt `tracker.db` with `--force` and add regression tests ([9041d58])
- **Foundation**: Detect corrupt database in non-force init and exit with recovery guidance ([2e5be3d])
- **Importers**: Normalize sensitive metadata key redaction and enforce symlink/junction containment ([9f25a20])
- **Importers**: Honor explicit `--source` paths, gate auto-discovery, add `--verbose` logging ([8ffbed2])
- **Scoring**: Exclude unavailable dimensions from aggregate denominator and scope test-confidence to active filters ([736a43e])
- **Scoring**: Prevent test-confidence from falling back to unrelated test outcomes when `--tool` filter has no sessions or sessions lack `project_id` ([e57783b])
- **Release**: Add fresh-checkout smoke test and browser automation validation ([ee93cb5])
- **Release**: Use explicit pwsh for clean checkout install/build and portable agent-browser resolution ([79d3a7d])
- **Dashboard**: Validate query params, redact raw exports, add project filter, rework/retry indicators, PATCH validation ([9a29701])
- **Dashboard**: Fix scrutiny regressions — `/api/tools` filters, hook ordering, raw export checkbox ([a7efb6f])
- **E2E**: Stabilize browser dashboard navigation with reliable wait-for-content ([5c27eba])
- **Dashboard**: Scope `/api/overview` outcomeCount to filtered sessions ([e5b638f])

[6f92585]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/6f92585
[9041d58]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/9041d58
[2e5be3d]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/2e5be3d
[d0c3ba4]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/d0c3ba4
[9f25a20]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/9f25a20
[8ffbed2]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/8ffbed2
[c787e7e]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/c787e7e
[736a43e]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/736a43e
[e57783b]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/e57783b
[1e686c6]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/1e686c6
[a4c895c]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/a4c895c
[840dbce]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/840dbce
[ee93cb5]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/ee93cb5
[79d3a7d]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/79d3a7d
[9a29701]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/9a29701
[a7efb6f]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/a7efb6f
[5c27eba]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/5c27eba
[e5b638f]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/e5b638f
[6e897a9]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/6e897a9
[4a83a15]: https://github.com/maliktafheem/coding-effectiveness-tracker/commit/4a83a15
