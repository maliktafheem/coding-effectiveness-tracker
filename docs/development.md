# Development

## Prerequisites

- **Node.js** >= 20
- **npm** (ships with Node.js)
- **Git** (for `cet sync` command and version control)

## Setup

```bash
# Clone the repository
git clone <repo-url>
cd coding-effectiveness-tracker

# Install dependencies
npm install

# Build (TypeScript + Vite dashboard)
npm run build

# Run all tests
npm test
```

## Available Scripts

| Command | Purpose |
|---------|---------|
| `npm run build` | Full build: TypeScript compilation + Vite dashboard bundle |
| `npm run build:server` | TypeScript compilation only |
| `npm run build:dashboard` | Vite dashboard bundle only |
| `npm run typecheck` | TypeScript type-checking without emitting files |
| `npm run lint` | ESLint on `src/` and `tests/` |
| `npm test` | Run all unit tests via Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:e2e` | Run end-to-end tests with verbose output |
| `npm run dev -- <args>` | Run the CLI directly via tsx (no build needed) |
| `npm run dev:local` | Build dashboard then start serve |

## Project Structure

```
coding-effectiveness-tracker/
├── bin/
│   └── cli.js                    # CLI entry point (Node.js shebang)
├── dist/
│   ├── server/                   # Compiled server TypeScript
│   └── dashboard/                # Built Vite SPA assets
├── src/
│   ├── cli.ts                    # CLI definition (commander)
│   ├── config.ts                 # Data directory resolution
│   ├── storage.ts                # SQLite storage (open, migrate, close)
│   ├── version.ts                # Version constant
│   ├── api/
│   │   ├── server.ts             # Fastify server creation
│   │   ├── routes.ts             # All API route handlers
│   │   └── export.ts             # JSON & Markdown export generators
│   ├── analytics/
│   │   ├── trends.ts             # Trend computation
│   │   ├── diff-service.ts       # Git diff caching and retrieval
│   │   └── prompt-quality/
│   │       ├── types.ts          # PromptAnalyzer interface + result types
│   │       ├── heuristic-v1.ts   # Heuristic-based prompt analyzer
│   │       ├── registry.ts       # Analyzer registry
│   │       └── service.ts        # Prompt quality scoring service
│   ├── commands/
│   │   ├── init.ts               # cet init handler
│   │   ├── import.ts             # cet import handler
│   │   ├── report.ts             # cet report handler
│   │   ├── annotate.ts           # cet annotate handler
│   │   ├── sync.ts               # cet sync handler
│   │   ├── test-outcome.ts       # cet test-outcome handler
│   │   ├── diff.ts               # cet diff handler
│   │   ├── prompt-quality.ts     # cet prompt-quality handler
│   │   ├── serve.ts              # cet serve handler
│   │   └── export.ts             # cet export handler
│   ├── collectors/
│   │   ├── git.ts                # Local git commit collection
│   │   └── test-outcomes.ts      # Test outcome ingestion
│   ├── correlation/
│   │   ├── engine.ts             # Session correlation engine
│   │   ├── ship-status.ts        # Session-level ship status derivation
│   │   └── pr-outcomes.ts        # GitHub PR outcome fetching
│   ├── dashboard/
│   │   ├── main.tsx              # React entry point
│   │   └── components/
│   │       ├── App.tsx           # Dashboard SPA (monolithic)
│   │       ├── DiffPanel.tsx     # Session diff display
│   │       ├── PromptQualityPage.tsx  # Prompt quality dashboard page
│   │       ├── ShipStatusPill.tsx # Ship status badge component
│   │       └── PRCard.tsx        # PR detail card component
│   ├── importers/
│   │   ├── types.ts              # ToolImporter interface + types
│   │   ├── registry.ts           # Importer registry + run logic
│   │   ├── privacy.ts            # Secret redaction, canary detection
│   │   ├── path-safety.ts        # Path traversal/symlink protection
│   │   ├── utils.ts              # JSONL parsing utility
│   │   ├── index.ts              # Barrel export, auto-registration
│   │   ├── codex.ts              # Codex importer
│   │   ├── opencode.ts           # OpenCode importer
│   │   ├── claude-code.ts        # Claude Code importer
│   │   ├── cursor.ts             # Cursor importer
│   │   └── factory-droid.ts      # Factory Droid importer
│   └── scoring/
│       └── effectiveness.ts      # Balanced effectiveness scoring
├── tests/
│   ├── cli.test.ts               # CLI framework tests
│   ├── init.test.ts              # Init command tests
│   ├── import.test.ts            # Import command tests
│   ├── storage.test.ts           # Storage/database tests
│   ├── api.test.ts               # API endpoint tests
│   ├── api-diff.test.ts          # API diff endpoint tests
│   ├── api-prompt-quality.test.ts # API prompt-quality endpoint tests
│   ├── api-ship-status.test.ts   # API ship status endpoint tests
│   ├── correlation.test.ts       # Correlation engine tests
│   ├── sync-cli.test.ts          # Sync + test-outcome CLI tests
│   ├── config.test.ts            # Config resolution tests
│   ├── setup.test.ts             # Setup command tests
│   ├── diff-service.test.ts      # Diff service tests
│   ├── cli-diff.test.ts          # CLI diff command tests
│   ├── cli-sync-pr.test.ts       # CLI sync --pr tests
│   ├── prompt-quality-heuristic.test.ts  # Heuristic analyzer tests
│   ├── prompt-quality-service.test.ts    # Prompt quality service tests
│   ├── cli-prompt-quality.test.ts        # CLI prompt-quality tests
│   ├── pr-outcomes.test.ts       # PR outcome fetching tests
│   ├── ship-status.test.ts       # Ship status derivation tests
│   ├── rework-dim.test.ts        # Rework dimension tests
│   ├── scoring-perf.test.ts      # Scoring performance tests
│   ├── manual-outcome-perf.test.ts # Manual outcome perf tests
│   ├── trends.test.ts            # Trend computation tests
│   ├── watch.test.ts             # Watch daemon tests
│   ├── auto-init.test.ts         # Auto-init tests
│   └── e2e.test.ts               # End-to-end workflow tests
├── docs/                         # Reference documentation
├── package.json
├── tsconfig.json
├── vite.config.ts               # Vite dashboard configuration
├── vitest.config.ts             # Vitest test configuration
└── eslint.config.js             # ESLint flat config
```

## Cross-Platform Notes

### Windows

- Default data directory: `%LOCALAPPDATA%\coding-effectiveness-tracker`
- The `cet` CLI is available via `npx cet` after build or local install
- PowerShell: `cet` works from any directory if the package is installed globally
- Paths with spaces or parentheses are handled correctly (tested)
- E2E tests use `pwsh` shell execution where needed

### macOS / Linux

- Default data directory: `~/.coding-effectiveness-tracker`
- XDG conventions are followed for source path discovery (XDG_CONFIG_HOME, XDG_DATA_HOME)
- All tests run identically; E2E tests skip Windows-specific sections gracefully

### Environment Variable

`CET_DATA_DIR` overrides the default data directory on all platforms.

### Data Directory Subdirectories

Once initialized, the data directory contains:
```
<data-dir>/
├── tracker.db         # SQLite database (WAL mode)
├── importers/         # Reserved for importer artifacts
├── exports/           # Reserved for exported reports
└── correlations/      # Reserved for correlation data
```

### Module System

The project uses **ESM** (`"type": "module"` in package.json). All imports use explicit `.js` extensions in TypeScript source (resolved to `.js` at runtime by Node.js ESM).
