# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
