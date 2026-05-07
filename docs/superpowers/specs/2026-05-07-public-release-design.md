# Public Release: Coding Effectiveness Tracker

**Date:** 2026-05-07
**Status:** Approved
**Version:** 0.1.0

## Goal

Prepare the Coding Effectiveness Tracker for public release on GitHub, making it polished enough that people discover, trust, install, and use it to track their own AI-assisted coding effectiveness.

## Scope

Six milestones covering documentation, npm packaging, community setup, CI/CD, cross-platform fixes and API polish, and visual demo. No new features -- only release-readiness work.

## Milestones

### Milestone 1: Foundation (Context Anchor)

Deliver a self-contained `docs/` folder that any developer (or future-you in a new chat) can read to understand the full project.

**Files to create:**
- `docs/README.md` -- Docs overview and navigation
- `docs/architecture.md` -- System design, components, dependency graph, key patterns
- `docs/development.md` -- Setup, build/test/lint commands, project structure, cross-platform notes
- `docs/cli-reference.md` -- Every CLI command with options and examples
- `docs/api-reference.md` -- REST API endpoints, query params, request/response examples
- `docs/data-model.md` -- SQLite schema (10 tables + indexes), entity relationships
- `docs/importer-guide.md` -- ToolImporter interface, adding new AI tools, path safety
- `docs/privacy.md` -- Local-first design, no telemetry, redaction pipeline, canary testing
- `CHANGELOG.md` -- Generated from 19-commit git history
- `LICENSE` -- Full MIT license text

**Files to update:**
- `README.md` -- Overhaul with badge header (build, npm, license, node), table of contents, quick-start, link to docs/
- `.gitignore` -- Add `.env`, `*.db-journal`, `*.db-wal`, `*.db-shm`

### Milestone 2: Package & npm Polish

Make `npm install -g coding-effectiveness-tracker` work cleanly.

**Files to update:**
- `package.json`:
  - Add `repository` field (type, url)
  - Add `homepage` field
  - Add `bugs` field (issue tracker URL)
  - Add `publishConfig` with `"access": "public"`
  - Add `prepublishOnly: "npm run build"` script
  - Move `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `vite` from `dependencies` to `devDependencies`
  - Update `keywords` to include `"productivity"`, `"cli"`, `"git"`, `"analytics"`

### Milestone 3: Community & GitHub

Make the repository feel alive and welcoming for contributors.

**Files to create:**
- `CONTRIBUTING.md` -- Setup, running tests, submitting PRs, code style
- `CODE_OF_CONDUCT.md` -- Contributor Covenant 2.1
- `.github/ISSUE_TEMPLATE/bug-report.md` -- Structured bug report template
- `.github/ISSUE_TEMPLATE/feature-request.md` -- Feature request template
- `.github/PULL_REQUEST_TEMPLATE.md` -- PR checklist template
- `.github/dependabot.yml` -- Weekly npm dependency updates

### Milestone 4: CI/CD

Automated testing on push/PR to build trust.

**Files to create:**
- `.github/workflows/ci.yml` -- GitHub Actions workflow:
  - Trigger on push/PR to master
  - Matrix: `ubuntu-latest`, `windows-latest`
  - Node versions: 18, 20, 22
  - Steps: checkout, setup node, `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`
  - Skip `agent-browser` e2e tests (require Factory environment)
  - Handle `better-sqlite3` native compilation

**Files to update:**
- `vitest.config.ts` -- Add coverage config (v8 provider, lcov+text reporters, 70%+ thresholds), CI-specific pool config (`pool: 'forks'`, `singleFork: true`), `retry: 2` for flaky fs/git tests
- `tests/helpers.ts` -- Extract shared helpers (`safeCleanup`, `runCli`, `createTestStorage`) from duplicated test code

### Milestone 5: Cross-Platform & API Polish

Fix issues found by the skill-guided deep-dive review that would immediately affect first-time users.

**Files to update:**
- `src/commands/import.ts` -- Fix `getDefaultSourcePaths()` to include Linux (`~/.config`) and macOS paths, not just Windows `AppData`
- `src/api/server.ts` -- Add centralized error handler via `app.setErrorHandler()` with consistent JSON error format
- `src/api/routes.ts` -- Add Zod schema validation for request bodies (annotations) and query params; replace unsafe `as` casts with Zod-parsed types
- `tests/e2e.test.ts` -- Gracefully skip platform-specific tests (agent-browser, pwsh, curl.exe) on unsupported platforms instead of crashing

### Milestone 6: Visual & Demo

Show people what they're getting.

- Capture 2-3 dashboard screenshots using fixture data flow
- Embed screenshots in README with captions
- Add quick-start demo section with copy-paste commands
- Minor React optimization: lazy-load page components (overview, timeline, tools, session detail, export) so initial bundle is smaller

## Non-Goals

- No new features or tool integrations
- No architecture changes (no migration from single-file App.tsx to multi-component structure)
- No cloud sync, telemetry, or hosted backend
- No GitHub release assets (can be added later via GitHub UI)

## Risks

| Risk | Mitigation |
|------|------------|
| `better-sqlite3` native compilation fails on CI Linux/macOS | Use `npm ci` with prebuild binaries; verify in workflow before merging |
| Agent-browser e2e tests cannot run in CI | Skip them explicitly in CI workflow; they are Factory-specific |
| Cross-platform path differences cause subtle bugs | Milestone 5 specifically addresses these; docs/development.md documents known gaps |
| Dashboard screenshots become stale | Include instructions in CONTRIBUTING.md for regenerating them |
