# Coding Effectiveness Tracker

<p align="center">
  <a href="https://www.npmjs.com/package/coding-effectiveness-tracker"><img src="https://img.shields.io/npm/v/coding-effectiveness-tracker" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/coding-effectiveness-tracker" alt="MIT License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >=20"></a>
  <a href="https://github.com/maliktafheem/coding-effectiveness-tracker/actions"><img src="https://img.shields.io/github/actions/workflow/status/maliktafheem/coding-effectiveness-tracker/ci.yml" alt="CI Status"></a>
</p>

> Stop guessing. See whether AI-assisted coding is actually shipping code.

<p align="center">
  <img src="docs/assets/screenshot-overview.png" alt="Overview dashboard showing effectiveness score, session count, and weekly trend" width="820">
</p>

Local-first tracker for AI coding sessions. Imports from Claude Code, Codex, OpenCode, Cursor, and Factory Droid. Correlates sessions with your local Git history and test results. Scores six dimensions. Everything stays on your machine — no telemetry, no accounts, loopback-only dashboard.

## Try it in 60 seconds

```bash
npm install && npm run build
npx cet setup
```

Dashboard opens at `http://127.0.0.1:43187`. Ctrl+C when done.

## What you see

<p align="center">
  <img src="docs/assets/screenshot-timeline.png" alt="Timeline of 24 sessions showing tool, project, summary, duration, correlation count, outcome, and rework attempts" width="820">
  <br><em>Timeline — every session linked to commits, test outcomes, and manual annotations</em>
</p>

<p align="center">
  <img src="docs/assets/screenshot-tools.png" alt="Per-tool comparison of Claude Code, Codex, OpenCode, Cursor showing sessions, outcomes, and effectiveness scores" width="820">
  <br><em>Tools — which AI helps you ship, which slows you down</em>
</p>

<p align="center">
  <img src="docs/assets/screenshot-session-detail.png" alt="Session detail showing tool, project, model, duration, tokens, cost, correlations, and annotations" width="820">
  <br><em>Session detail — drill into tokens, cost, correlated commits, and outcomes</em>
</p>

---

## Table of Contents

- [Privacy and Local-First Design](#privacy-and-local-first-design)
- [Prerequisites](#prerequisites)
- [Install, Build, and Test](#install-build-and-test)
- [Quick Start](#quick-start)
  - [One-Command Setup (Recommended)](#1-one-command-setup-recommended)
  - [Initialize](#2-initialize)
  - [Import Fixture Data](#3-import-fixture-data)
  - [Import from a Tool](#4-import-from-a-tool)
  - [Sync with Git](#5-sync-with-git)
  - [Annotate Sessions](#6-annotate-sessions)
  - [Generate a Report](#7-generate-a-report)
  - [Start the Dashboard](#8-start-the-dashboard)
- [CLI Command Reference](#cli-command-reference)
- [Dashboard, API, and Exports](#dashboard-api-and-exports)
- [Data Directory](#data-directory)
- [Documentation](#documentation)

---

## Privacy and Local-First Design

Coding Effectiveness Tracker stores data on your machine and runs the dashboard/API on loopback (`127.0.0.1`). It does not provide cloud sync, telemetry, or a hosted backend. Import discovery is explicit opt-in, and verbose import output applies pattern-based redaction for common secret formats — see [Privacy docs](docs/privacy.md#limitations-and-known-gaps) for what may not be caught.

## Prerequisites

- Node.js 20 or newer (Node 18 reached end-of-life April 2025)
- npm
- Git, if you want to sync commit history from local repositories

## Install, Build, and Test

> **Note:** This package is not yet published on npm. Install from the local repository.
> The CI status badge above renders "no status" until the repository is pushed to GitHub and the `ci.yml` workflow has run at least once on the default branch.

```powershell
npm install
npm run build
npm test
```

During development, run the CLI directly with:

```powershell
npm run dev -- --help
npm run dev -- init
```

After building or installing globally, the CLI command is `cet`.

## Quick Start

> **Cross-platform:** Examples show PowerShell (Windows). For macOS/Linux, replace `%LOCALAPPDATA%` with `~/.coding-effectiveness-tracker` and Windows paths with POSIX equivalents.

### 1. One-Command Setup (Recommended)

The fastest way to get started:

```powershell
cet setup
```

This single command initializes your workspace, discovers AI sessions from installed tools,
syncs with your current Git repo, and starts the dashboard. Open the printed URL to see your data.

Or for a lighter start without the dashboard:

```powershell
cet setup --no-serve
```

For step-by-step guidance, use interactive mode:

```powershell
cet setup --interactive
```

### 2. Initialize

Initialize the local workspace and SQLite database:

```powershell
cet init
```

### 3. Import Fixture Data

Try the tool with bundled sample data:

```powershell
cet import --fixture tests/fixtures/sessions-fixture.json
```

### 4. Import from a Tool

Import sessions from a supported local AI coding tool:

```powershell
cet import --tool claude-code --discover
```

Supported tools: `claude-code`, `codex`, `opencode`, `cursor`, `factory-droid`.

### 5. Sync with Git

Correlate sessions with a local Git repository:

```powershell
cet sync --repo C:\path\to\repo
```

### 6. Annotate Sessions

Add a manual outcome annotation:

```powershell
cet annotate --session <session-id> --outcome shipped --score 1 --note "Merged with tests passing"
```

### 7. Track Test Outcomes

Run a test command and capture the result:

```powershell
cet test -- npm test
cet test -- pytest tests/
```
```bash
# macOS / Linux
cet test -- pytest tests/
cet test -- npm test
```

### 8. Compare Tools, Sessions, or Periods

Compare effectiveness across different dimensions:

```powershell
cet compare --tool claude-code vs codex
cet compare --from 2025-01-01 --to 2025-01-31 vs 2025-02-01 --to 2025-02-28
```

### 9. Generate a Report

Generate an effectiveness report:

```powershell
cet report
```

### 10. Start the Dashboard

Start the local dashboard and API server:

```powershell
cet serve
```

## CLI Command Reference

| Command | Purpose |
| --- | --- |
| `cet setup [--no-serve] [--interactive]` | One-command onboarding: init, discover AI tools, import sessions, sync git, start dashboard. |
| `cet init [--data-dir <path>] [--force]` | Initialize the local tracker workspace and database. |
| `cet import [--tool <id>] [--source <path>] [--fixture <path>] [--discover] [--dry-run] [--verbose]` | Import AI coding sessions from Codex, OpenCode, Claude Code, Cursor, or Factory Droid. |
| `cet sync --repo <path> [--project <id>]` | Read local Git commits and correlate them with imported sessions. |
| `cet test -- <command>` | Run a user command and capture pass/fail outcome and exit code. |
| `cet test-outcome [--outcome-json <path>] [--command <str>] [--passed <n>] [--failed <n>] [--skipped <n>] [--duration <ms>]` | Ingest local test result artifacts or command outcome records. |
| `cet compare [--tool <id>] [--from <date>] [--to <date>] vs [--tool <id>] [--from <date>] [--to <date>]` | Compare sessions, tools, or time periods. |
| `cet trends [--project <id>]` | Show weekly trend analytics with rolling averages. |
| `cet tag --session <id> [--tags <tags>] [--remove] [--list]` | Add, remove, or list tags on a session for filtering. |
| `cet annotate --session <id> [--outcome <label>] [--score <number>] [--note <text>] [--tags <tags>]` | Record a manual outcome annotation for a session. |
| `cet report [--json] [--tool <id>] [--project <id>] [--from <date>] [--to <date>]` | Generate an effectiveness report from imported data. |
| `cet serve [--port <port>]` | Start the local dashboard and API server on `127.0.0.1`; default port is `43187`. |
| `cet export --output <path> [--format json\|markdown] [--overwrite] [--tool <id>] [--project <id>] [--from <date>] [--to <date>]` | Export an effectiveness report to a local file. |
| `cet watch [--interval <min>] [--stop] [--status]` | Background daemon that polls for new AI sessions and git changes. Start, stop, or check status. |

Most commands also accept `--data-dir <path>` to use a custom tracker data directory.

For detailed CLI reference, see [docs/cli-reference.md](docs/cli-reference.md).

## Dashboard, API, and Exports

Run `cet serve` and open the printed local address to view the dashboard. The local API includes:

- `GET /health`
- `GET /api/overview`
- `GET /api/timeline`
- `GET /api/tools`
- `GET /api/projects`
- `GET /api/trends`
- `GET /api/available-tools`
- `GET /api/sessions/:id`
- `POST /api/sessions/:id/annotations`
- `PATCH /api/annotations/:id`
- `GET /api/export/json`
- `GET /api/export/markdown`

Use query filters such as `tool`, `project`, `from`, `to`, and `raw=true` where supported. For file exports, use `cet export --format json --output report.json` or `cet export --format markdown --output report.md`.

For detailed API reference, see [docs/api-reference.md](docs/api-reference.md).

## Data Directory

By default, tracker data is stored in `%LOCALAPPDATA%\coding-effectiveness-tracker` on Windows and `~/.coding-effectiveness-tracker` on other platforms. Override this with `--data-dir <path>` or the `CET_DATA_DIR` environment variable. The data directory contains the local SQLite database plus importer, export, and correlation subdirectories.

For more information about the data model, see [docs/data-model.md](docs/data-model.md).

## Documentation

Comprehensive documentation is available in the [docs/](docs/) folder:

- [Architecture](docs/architecture.md) — System components, data flow, and key patterns
- [Development Guide](docs/development.md) — Setup, build/test, project structure, cross-platform notes
- [CLI Reference](docs/cli-reference.md) — All CLI commands with options and examples
- [API Reference](docs/api-reference.md) — All 12 API endpoints with query parameters and response shapes
- [Data Model](docs/data-model.md) — Database tables, columns, indexes, and relationships
- [Scoring Model](docs/scoring.md) — Effectiveness dimensions, weights, and configuration
- [Importer Guide](docs/importer-guide.md) — ToolImporter interface, registration, and privacy redaction
- [Privacy](docs/privacy.md) — Local-first architecture, telemetry, and redaction pipeline
