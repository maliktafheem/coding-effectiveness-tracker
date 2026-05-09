# README Refresh + Screenshot Automation

Date: 2026-05-10
Audience: developer with curiosity; hero screenshot + 60-second quickstart; playwright automation; top-half README rewrite only.

## Goal

Replace three stale 1280-wide PNGs in `docs/assets/` with realistic, high-resolution screenshots generated from a repeatable playwright script. Rewrite the top of README.md to lead with visual proof of value. Keep existing CLI table + API list + docs links unchanged.

## In-scope

### S1 — Demo data seeder

New file: `scripts/seed-demo.ts` (not packed).

- Opens a Storage in a scratch dir (`docs/assets/.demo-data/`).
- Inserts 24 sessions across four weeks, mix:
  - 50% `claude-code`, 30% `codex`, 15% `opencode`, 5% `cursor`
  - Realistic summaries (e.g., "Refactor auth middleware", "Add rate limit tests", "Debug flaky test in checkout")
  - tokens_input/output + cost_estimate on ~80% of rows
  - 2 sessions with metadata.reworkCount > 0 (to make rework dim fire)
- Seeds one `projects` row per unique path.
- Generates 22 `git_commits` rows linked to a subset of sessions (70% coverage). Realistic hash (8 hex) + message + author "Demo User" + branch `main`/`feat/auth`/`feat/search`.
- Generates 6 `test_outcomes` rows spread across the window: 4 pass-only, 2 with 1-2 failures.
- Generates 8 `outcomes` rows (manual annotations): outcomes from ["shipped","merged","partial","reverted"], scores 0.3-1.0.
- Runs correlation engine over the seeded data so correlation counts populate naturally.
- Copies `scoring.json` (default weights) into the data dir. Leaves `tracker.db` ready.

Entry: `tsx scripts/seed-demo.ts`.

### S2 — Screenshot automation

New file: `scripts/capture-screenshots.ts` (not packed).

- Spawns `tsx src/cli.ts serve --data-dir docs/assets/.demo-data --port 43287` as child process.
- Waits for `/health` to respond 200 (polling with 500ms backoff, max 15s).
- Launches playwright chromium headless, viewport 1600×1000.
- Navigates:
  1. `http://127.0.0.1:43287/#overview` → `docs/assets/screenshot-overview.png`
  2. `/#timeline` → `docs/assets/screenshot-timeline.png`
  3. `/#tools` → `docs/assets/screenshot-tools.png`
  4. Click first timeline row → wait for detail render → `docs/assets/screenshot-session-detail.png`
- Each capture: full-page PNG, scale 1.5× for crisp display on retina.
- Graceful teardown: close browser, kill server, even on failure.

Existing files to delete: `screenshot-overview.png`, `screenshot-Timeline.png`, `screenshot-Tools.png`. New files: lowercase, hyphenated, 4 total.

Playwright: use direct `playwright` npm install (devDep). `@vitest/browser-playwright` already resolves playwright transitively — confirm the peer before installing.

### S3 — README top-half rewrite

Replace lines 1–34 of current README.md (everything up to "## Privacy and Local-First Design"). Keep badges row and everything from Privacy section onward intact.

New top-half structure:

```
# Coding Effectiveness Tracker
[badges row — unchanged]

> Stop guessing. See if AI-assisted coding is actually shipping code.

[hero: docs/assets/screenshot-overview.png, centered, width=820]

Local-first tracker. Imports sessions from Claude Code, Codex, OpenCode,
Cursor, and Factory Droid. Correlates them with your local git history and
test results. Scores six dimensions. Everything stays on your machine — no
telemetry, no accounts, loopback-only dashboard.

## Try it in 60 seconds

```bash
npm install && npm run build
npx cet setup
```

Dashboard opens at `http://127.0.0.1:43187`. Ctrl+C when done.

## What you see

<three-column screenshot row>
| Overview | Timeline | Tools |
| score across 6 dimensions | session-by-session | which AI helps you ship |
```

No "Table of Contents" in top half — collapse into the existing TOC further down.

### S4 — Cleanup

- Delete three old screenshots.
- Ensure `docs/assets/.demo-data/` is `.gitignore`d (it is scratch — not committed).
- Add `scripts/` to `.gitignore`? No — scripts committed, demo-data dir inside assets ignored via targeted rule.
- `README.md` commits reference screenshot paths by the new lowercase names only.

## Non-goals

- No changes to dashboard visuals or CSS.
- No animated GIFs or videos.
- No SEO tricks (og:image tags, badges beyond existing set).
- No marketing copy in docs/ subfiles — those stay reference-style.
- No CHANGELOG entry for README polish.

## Risks

- Playwright fetch of chromium on CI may be flaky; scripts are user-run, not CI-run. Add note in script comments.
- `cet serve` child process teardown on Windows — use `tree-kill` pattern or platform check. Default to `process.kill(-pid)` falling back to `.kill('SIGTERM')`.
- Emoji / Unicode in fixture data: keep ASCII-only to avoid encoding surprises in PNG text layers.
- If Playwright install fails, leave fallback instructions in the script file header.

## Verification gate

- `npm run typecheck && npm run lint && npm test` — all pass.
- Run `tsx scripts/seed-demo.ts` — produces `docs/assets/.demo-data/tracker.db`, no errors.
- Run `tsx scripts/capture-screenshots.ts` — four PNGs exist under `docs/assets/`, file sizes > 50 kB each.
- `git status` — only `scripts/*.ts`, `README.md`, four new PNGs, three deleted PNGs.
