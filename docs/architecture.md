# Architecture

## Overview

The Coding Effectiveness Tracker (CET) is a **local-first**, **privacy-preserving** tool for analyzing AI-assisted coding workflows. It imports sessions from popular AI coding tools, correlates them with Git commits and test outcomes, computes balanced effectiveness scores, and surfaces everything through a CLI, a local dashboard, and exportable reports.

All data stays on the user's machine. There is no cloud backend, no telemetry, and no hosted service.

---

## System Components

```
┌────────────────────────────────────────────────────────────┐
│                        CLI (commander)                      │
│  init  import  sync  test-outcome  annotate  report  serve  │
│                           export                            │
└──────┬─────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────┐
│                    Importer Framework                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐ │
│  │  Codex   │ │OpenCode  │ │ClaudeCode│ │Factory Droid  │ │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘ │
│  ┌──────────┐                                              │
│  │  Cursor  │  Registry · Privacy · Path Safety            │
│  └──────────┘                                              │
└──────┬─────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────┐
│                     Storage (better-sqlite3)                │
│  9 tables: projects, tools, sessions, events, git_commits,  │
│  test_outcomes, outcomes, correlations, _migrations           │
└──────┬─────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────┐
│              Collectors · Correlation · Scoring             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ Git Collector │  │Test Collector│  │Correlation Engine│ │
│  │ (local only)  │  │ (local only) │  │(time-overlap +   │ │
│  └──────────────┘  └──────────────┘  │ project matching) │ │
│                                       └──────────────────┘ │
│  ┌──────────────────────────────────────────────────────┐  │
│  │          Scoring Engine (6 dimensions)                │  │
│  │  activity-output · git-correlation · test-confidence  │  │
│  │  manual-outcome · cost-efficiency · rework-indicator  │  │
│  │  (balanced: unavailable dimensions excluded from      │  │
│  │   weighted denominator)                               │  │
│  └──────────────────────────────────────────────────────┘  │
└──────┬─────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────┐
│               API Server (Fastify · loopback only)          │
│  10 endpoints: /health, /api/overview, /api/timeline,       │
│  /api/tools, /api/projects, /api/sessions/:id,              │
│  POST /api/sessions/:id/annotations,                        │
│  PATCH /api/annotations/:id,                                │
│  /api/export/json, /api/export/markdown                     │
└──────┬─────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────┐
│           Dashboard (React + Vite · SPA)                    │
│  Served via Fastify static. Loaded in browser at            │
│  http://127.0.0.1:<port>                                    │
└────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Import Flow

```
1. User runs: cet import --source <path> [--discover]
2. CLI resolves data directory and opens SQLite storage
3. Import handler discovers matching importers via canHandle()
4. Each importer:
   a. Scans source path for supported files (.jsonl, .json, .log)
   b. Parses records and normalizes into NormalizedSession objects
   c. Applies privacy redaction (secrets, canaries, sensitive keys)
   d. Returns ImportResult with sessions
5. Registry.runImport() writes sessions to SQLite
   - Upsert via (source_tool_id, external_id) unique index
   - Events are inserted alongside sessions
   - Projects are auto-created if referenced
6. Privacy statement printed; no remote calls made
```

### Sync & Correlation Flow

```
1. User runs: cet sync --repo <path>
2. Git collector runs `git log --all` locally (NO remote fetch)
3. Commits stored in git_commits table (idempotent by hash)
4. Correlation engine:
   a. For each imported session, finds commits within time window
   b. Calculates confidence based on time proximity + project match
   c. Stores correlations in correlations table
5. Same process for test-outcome correlation
```

### Report Flow

```
1. User runs: cet report [--json] [--tool ...] [--project ...]
2. Queries sessions table with optional filters
3. Scoring engine computes 6-dimension balanced effectiveness score
4. Results printed as human-readable table or JSON
```

### Serve Flow

```
1. User runs: cet serve [--port <port>]
2. Fastify server created, bound to 127.0.0.1 only
3. API routes registered
4. Built dashboard SPA served statically (if dist/dashboard exists)
5. CORS protection: write mutations (POST/PATCH/DELETE) blocked
   for cross-origin requests from non-loopback origins
6. SIGINT/SIGTERM shuts down gracefully
```

---

## Key Design Patterns

### Idempotent Operations

All write operations are idempotent:
- **Import**: `(source_tool_id, external_id)` unique index prevents duplicate sessions
- **Sync**: `(hash, project_id)` uniqueness prevents duplicate commits
- **Test outcomes**: `(command, run_at, project_id)` deduplication
- **Init**: `INSERT OR IGNORE` for default tools; migration tracking

### Importer Plugin Architecture

Five built-in importers implement the `ToolImporter` interface:
- Each importer self-identifies via `canHandle(sourcePath)` — no central file-type mapping
- Importers are registered via `registerImporter()` at import time
- The registry auto-discovers which importers can handle a given path
- A `registerAllImporters()` call happens at module load time to auto-register built-ins

### Balanced Scoring with Missing-Dimension Handling

The scoring engine (computeEffectivenessScore) evaluates 6 dimensions:
1. **activity-output** (15%) — session count
2. **git-correlation** (25%) — sessions linked to git commits
3. **test-confidence** (25%) — test pass rate + correlation coverage
4. **manual-outcome** (15%) — user annotation scores
5. **cost-efficiency** (10%) — average cost per session
6. **rework-indicator** (10%) — retry/rework rates

**Key invariant**: dimensions with no available data are excluded from the weighted denominator, so missing input does not depress the aggregate score as a zero. Missing dimensions are reported separately in `missingInputs`.

### Privacy-First Redaction

All sensitive content is redacted at the importer boundary before storage:
- Secret patterns (API keys, tokens, JWTs) via regex
- Canary secrets for test verification
- Sensitive metadata keys (apiKey, secret, password, token, auth)
- Terminal output is sanitized with truncation
- Raw metadata is excluded from exports unless `raw=true` is explicitly passed

### Path Safety

Importer path scanning uses `safeResolvePath`, `safeReadDir`, and `assertNoSymlinkEscape` to prevent:
- Path traversal attacks (.. escape)
- Absolute path injection
- Symlink escape outside the root directory

### Loopback-Only Network

The API server refuses to bind to any non-loopback address. Default host is `127.0.0.1`. If a non-loopback host is passed, the server throws at startup.

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 18 |
| Language | TypeScript (strict mode) |
| CLI Framework | commander |
| Database | better-sqlite3 (SQLite, WAL mode) |
| API Server | Fastify |
| Dashboard | React + Vite |
| Testing | Vitest |
| Module System | ESM (type: module) |
