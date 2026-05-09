# CLI Reference

The CLI binary is `cet`. Run `cet --help` to see all commands.

```
cet <command> [options]
```

## Global Flags

| Flag | Description |
|------|-------------|
| `-v, --version` | Print version number |
| `--help` | Print help text |

## Commands

### `cet setup`

One-command onboarding: initialize workspace, discover AI tools, sync git, and start the dashboard.

```
cet setup [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `--port <port>` | number | 43187 | Dashboard port |
| `--no-serve` | boolean | false | Skip starting the dashboard server |
| `--interactive` | boolean | false | Ask which tools to import and which repo to sync |

**Behavior:**
- Auto-initializes workspace if not already initialized (calls `cet init` silently)
- Auto-discovers AI tool directories and imports sessions from default paths
- If no tools found, prints guidance on where to place tool data
- Walks up parent directories from cwd to find .git and syncs commits
- Starts the dashboard server on the default port (43187) and prints the URL
- **Default mode** runs everything automatically with no prompts
- **`--no-serve`** runs init, import, and sync but skips starting the dashboard
- **`--interactive`** prompts for tool selection and repo path, showing detected defaults

**Examples:**

```bash
# Full auto-onboarding
cet setup

# Skip dashboard, just initialize and import
cet setup --no-serve

# Interactive mode
cet setup --interactive

# Custom port
cet setup --port 8080

# Custom data directory
cet setup --data-dir ~/my-tracker-data
```

**Output:**

```
✔ Workspace initialized
✔ Discovered sessions from: claude-code, cursor
✔ Synced 47 commits from /home/user/projects/my-app
  Dashboard: http://127.0.0.1:43187
  Privacy: All data stays local. No telemetry.
```

---


### `cet init`

Initialize a local tracker workspace with configuration and SQLite database.

```
cet init [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `--force` | boolean | false | Force reinitialization (overwrites existing database) |

**Behavior:**
- Creates data directory and subdirectories (`importers/`, `exports/`, `correlations/`)
- Creates `tracker.db` with all tables and indexes
- Inserts default tool records: Codex, OpenCode, Factory Droid, Claude Code, Cursor
- **Idempotent**: second run without `--force` prints existing path and exits
- `--force` handles corrupt databases by moving the corrupt file aside and reinitializing

**Examples:**
```bash
# Initialize with defaults
cet init

# Initialize with custom data directory
cet init --data-dir ~/my-tracker-data

# Force re-initialize after corruption
cet init --force
```

**Output:**
```
Initialized workspace at: /home/user/.coding-effectiveness-tracker
Database: /home/user/.coding-effectiveness-tracker/tracker.db
Registered AI tools: Codex, OpenCode, Factory Droid, Claude Code, Cursor
Privacy: All data stays local. No telemetry or external services.
```

---

### `cet import`

Import AI coding sessions from local tool data.

```
cet import [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `-s, --source <path>` | string | — | Explicit source path to import from |
| `-t, --tool <id>` | string | — | Tool id: `codex`, `opencode`, `claude-code`, `cursor`, `factory-droid` |
| `-f, --fixture <path>` | string | — | Import from a fixture JSON file |
| `--dry-run` | boolean | false | Preview import without writing to database |
| `--discover` | boolean | false | Scan default AI tool directories for importable data |
| `--verbose` | boolean | false | Enable verbose/debug output (privacy-safe: secrets/prompts redacted) |

**Modes:**

1. **Fixture import** (`--fixture <path>`): Import from a fixture JSON file (array of NormalizedSession objects)
2. **Specific tool** (`--tool + --source`): Import from a specific tool's source path
3. **Explicit source** (`--source` alone): Discover which importers can handle the path
4. **Auto-discovery** (`--discover`): Scan default tool directories (requires explicit opt-in)

**Supported file types:** `.jsonl`, `.json`, `.log`

**Examples:**
```bash
# Import from fixture
cet import --fixture ./fixtures/sessions.json

# Import from a specific tool and source
cet import --tool codex --source ~/.codex/sessions

# Scan for importable data
cet import --discover

# Dry-run preview
cet import --tool claude-code --source ~/.claude --dry-run

# Verbose mode with diagnostics
cet import --source ~/.cursor --verbose
```

---

### `cet sync`

Sync local Git repository commits and correlate with imported sessions (local-only, no remote calls).

```
cet sync [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `-r, --repo <path>` | string | **required** | Path to local Git repository |
| `-p, --project <id>` | string | (repo dir name) | Project ID |

**Behavior:**
- Runs `git log --all` locally — NO remote fetch or API calls
- Idempotent: re-running does not duplicate commits (keyed by hash)
- Auto-derives project ID from repo directory name if not specified
- Correlates stored commits with imported sessions via time-overlap confidence scoring
- Creates project record in database if it doesn't exist

**Examples:**
```bash
# Sync a repository (project auto-derived)
cet sync --repo ~/projects/my-app

# Sync with explicit project ID
cet sync --repo ~/projects/my-app --project my-app

# Sync with custom data directory
cet sync --data-dir ~/my-data --repo ~/projects/my-app
```

---

### `cet test-outcome`

Ingest local test result artifacts or command outcome records and correlate with sessions.

```
cet test-outcome [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `-p, --project <id>` | string | "default" | Project ID |
| `--outcome-json <path>` | string | — | JSON file with array of test outcome records |
| `--command <str>` | string | — | Test command name |
| `--passed <n>` | number | 0 | Number of passed tests |
| `--failed <n>` | number | 0 | Number of failed tests |
| `--skipped <n>` | number | 0 | Number of skipped tests |
| `--duration <ms>` | number | 0 | Duration in milliseconds |
| `--run-at <datetime>` | string | now | ISO datetime of the test run |
| `--session <id>` | string | — | Session ID to link outcome to |
| `--commit <hash>` | string | — | Commit hash to link outcome to |

**JSON file format:**
```json
[
  {
    "command": "npm test",
    "passed": 10,
    "failed": 0,
    "skipped": 2,
    "durationMs": 15000,
    "runAt": "2025-01-15T10:30:00Z",
    "sessionId": "<optional>",
    "commitId": "<optional>"
  }
]
```

**Examples:**
```bash
# Ingest from JSON artifact
cet test-outcome --outcome-json ./test-results.json

# Inline outcome
cet test-outcome --command "npm test" --passed 10 --failed 0 --duration 15000

# Link outcome to a specific session
cet test-outcome --command "vitest run" --passed 335 --failed 0 --session abc-123
```

---

### `cet annotate`

Record a manual outcome annotation for a session.

```
cet annotate [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `--session <id>` | string | **required** | Session ID to annotate |
| `--outcome <label>` | string | — | Outcome label (see below) |
| `--score <number>` | number | — | Outcome score between 0 and 1 |
| `--note <text>` | string | — | Free-text note |
| `--tags <tags>` | string | — | Comma-separated tags |

**Valid outcome labels:**
`good`, `accepted`, `merged`, `shipped`, `ok`, `neutral`, `partial`, `poor`, `rejected`, `reverted`, `abandoned`, `unknown`

**Examples:**
```bash
# Record a positive outcome
cet annotate --session abc-123 --outcome shipped --score 1 --note "Merged with tests passing"

# Record a neutral outcome with tags
cet annotate --session abc-123 --outcome neutral --tags "exploratory,research"

# Record a negative outcome
cet annotate --session abc-123 --outcome rejected --score 0.2
```

---

### `cet report`

Generate an effectiveness report from imported data.

```
cet report [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `--json` | boolean | false | Output as JSON |
| `-t, --tool <id>` | string | — | Filter by source tool id |
| `-p, --project <id>` | string | — | Filter by project id |
| `--from <date>` | string | — | Start date filter (ISO date or datetime) |
| `--to <date>` | string | — | End date filter (ISO date or datetime) |

**Output (human-readable):**
```
═══════════════════════════════════════════════
  Coding Effectiveness Report
═══════════════════════════════════════════════

  Sessions: 47
  Sources: codex, claude-code
  Period: 2025-01-01 → 2025-03-15

  ── Effectiveness Score ──────────────────────
  Aggregate: 72%

  • activity-output: 100% — 47 AI session(s) completed in the selected period.
  • git-correlation: 68% — 32 of 47 sessions correlated with git commits (68%).
  • test-confidence: 85% — Test pass rate: 92% (335/364 passed). 28 sessions linked to test outcomes.
  • manual-outcome: 70% — Average manual outcome score: 70% from 12 annotation(s).
  • cost-efficiency: 55% — 40 session(s) with cost data. Total cost: $8.50.
  • rework-indicator: 90% — 3 of 47 session(s) had rework/retry attempts.

  ── Missing/Partial Inputs ──────────────────
  ⚠ Test outcome data not available for tool 'claude-code'

Privacy: All data stays local. No telemetry or external services.
```

**JSON output** includes the same data structured with `score`, `sessions`, `sources`, `period`, and `totalSessions` fields.

**Examples:**
```bash
# Human-readable report
cet report

# JSON report
cet report --json

# Filter by tool and project
cet report --tool codex --project my-app

# Filter by date range
cet report --from 2025-01-01 --to 2025-03-31
```

---

### `cet serve`

Start the local dashboard and API server (loopback only, 127.0.0.1).

```
cet serve [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `-p, --port <port>` | number | 43187 | Port to listen on |

**Behavior:**
- Binds to `127.0.0.1` only — refuses non-loopback hosts
- Serves built React dashboard SPA statically if `dist/dashboard/` exists
- Prints local URL and privacy statement on start
- Handles SIGINT/SIGTERM for graceful shutdown
- Reports EADDRINUSE with helpful message if port is occupied

**Examples:**
```bash
# Start on default port
cet serve

# Start on custom port
cet serve --port 8080

# Start with custom data directory
cet serve --data-dir ~/my-data --port 9000
```

**Output:**
```
Coding Effectiveness Tracker Dashboard

 URL:      http://127.0.0.1:43187
 Health:   http://127.0.0.1:43187/health
 Privacy: All data stays local. No telemetry or external services.

Press Ctrl+C to stop.
```

---

### `cet export`

Export an effectiveness report to a local file.

```
cet export [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `-f, --format <fmt>` | string | "json" | Export format: `json` or `markdown` |
| `-o, --output <path>` | string | **required** | Output file path |
| `--overwrite` | boolean | false | Overwrite existing file |
| `-t, --tool <id>` | string | — | Filter by source tool id |
| `-p, --project <id>` | string | — | Filter by project id |
| `--from <date>` | string | — | Start date filter |
| `--to <date>` | string | — | End date filter |

**Examples:**
```bash
# Export JSON report
cet export --format json --output report.json

# Export Markdown report with overwrite
cet export --format markdown --output report.md --overwrite

# Filtered export
cet export --format json --output codex-report.json --tool codex --from 2025-01-01
```
---

### `cet watch`

Start, stop, or check the status of a background daemon that keeps tracker data fresh.

```
cet watch [options]
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-d, --data-dir <path>` | string | — | Custom data directory path |
| `--stop` | boolean | false | Stop the running daemon |
| `--status` | boolean | false | Check daemon status |
| `--interval <minutes>` | number | 10 | Polling interval in minutes (minimum: 1) |

**Daemon behavior (start mode):**
- Forks a background Node.js process that polls every N minutes
- Stores PID in `<dataDir>/watch.pid` for lifecycle management
- Each poll cycle: auto-init check, discover/import new AI sessions, sync git commits
- Logs activity to `<dataDir>/watch.log` with timestamps
- Graceful shutdown on SIGTERM/SIGINT: cleans PID file, logs shutdown

**Stop behavior (`--stop`):**
- Reads PID from `<dataDir>/watch.pid`, sends termination signal
- Waits for clean exit, removes PID file
- If no PID file: prints "Daemon not running" and exits 0
- If stale PID (process dead): cleans up and prints message

**Status behavior (`--status`):**
- PID file exists + process alive: prints "Daemon running (PID: <pid>)"
- PID file exists + process dead: cleans up and prints "Daemon not running (stale PID cleaned)"
- No PID file: prints "Daemon not running"

**Examples:**
```bash
# Start daemon with default 10-minute interval
cet watch

# Start daemon with 5-minute polling
cet watch --interval 5

# Check daemon status
cet watch --status

# Stop daemon
cet watch --stop

# Custom data directory
cet watch --data-dir ~/my-tracker-data --interval 15
```
