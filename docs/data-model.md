# Data Model

The database is SQLite (via better-sqlite3), stored in `tracker.db` within the data directory. WAL journal mode is enabled for better concurrent read performance.

All timestamps are ISO 8601 strings stored as TEXT.

## Table Summary

| # | Table | Purpose |
|---|-------|---------|
| 1 | `projects` | Project definitions (auto-created from import/sync) |
| 2 | `tools` | AI tool registry (seeded at init) |
| 3 | `sessions` | AI coding sessions (main entity) |
| 4 | `events` | Event records within sessions |
| 5 | `git_commits` | Local git commit metadata |
| 6 | `session_commits` | Many-to-many session ↔ commit join |
| 7 | `test_outcomes` | Test result records |
| 8 | `outcomes` | Manual outcome annotations |
| 9 | `correlations` | Correlation records (session ↔ signal) |
| 10 | `_migrations` | Migration tracking (internal) |

---

## `projects`

Project definitions. Created automatically when sessions reference a new project ID or when `cet sync` runs against a repository.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Unique project identifier |
| `name` | TEXT | NOT NULL | Human-readable project name |
| `path` | TEXT | — | Filesystem path (for synced repos) |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Creation timestamp |
| `updated_at` | TEXT | NOT NULL, DEFAULT now | Last update timestamp |

**Indexes:** None beyond PRIMARY KEY.

---

## `tools`

AI tool definitions. Seeded at `cet init` with 5 default tools: Codex, OpenCode, Factory Droid, Claude Code, Cursor.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Tool identifier (e.g., `codex`) |
| `name` | TEXT | NOT NULL | Short name (e.g., `codex`) |
| `display_name` | TEXT | NOT NULL | Display name (e.g., `Codex`) |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Creation timestamp |

**Indexes:** None beyond PRIMARY KEY.

---

## `sessions`

The main entity representing an AI coding session. Each session is imported from a local AI tool and identified uniquely by `(source_tool_id, external_id)`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `source_tool_id` | TEXT | NOT NULL, FK → tools(id) | Source AI tool |
| `project_id` | TEXT | FK → projects(id) | Associated project |
| `external_id` | TEXT | — | External session identifier from the tool |
| `started_at` | TEXT | — | ISO 8601 session start |
| `ended_at` | TEXT | — | ISO 8601 session end |
| `duration_ms` | INTEGER | — | Duration in milliseconds |
| `summary` | TEXT | — | Privacy-redacted session summary |
| `model` | TEXT | — | AI model identifier |
| `tokens_input` | INTEGER | — | Input token count |
| `tokens_output` | INTEGER | — | Output token count |
| `cost_estimate` | REAL | — | Estimated cost in USD |
| `metadata_json` | TEXT | — | JSON blob (excluded from exports unless `raw=true`) |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Creation timestamp |
| `updated_at` | TEXT | NOT NULL, DEFAULT now | Last update timestamp |

**Indexes:**

| Index Name | Columns | Notes |
|------------|---------|-------|
| `idx_sessions_source_tool` | `source_tool_id` | Filter/join by tool |
| `idx_sessions_project` | `project_id` | Filter/join by project |
| `idx_sessions_started_at` | `started_at` | Date range queries |
| `idx_sessions_source_external` | `source_tool_id, external_id` | **UNIQUE** — prevents duplicate imports (WHERE external_id IS NOT NULL) |

---

## `events`

Individual events/turns within a session. Represent messages, prompts, responses, or other granular activity records.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `session_id` | TEXT | NOT NULL, FK → sessions(id) | Parent session |
| `event_type` | TEXT | NOT NULL | Event type (e.g., `turn`, `prompt`) |
| `occurred_at` | TEXT | — | ISO 8601 event timestamp |
| `summary` | TEXT | — | Privacy-redacted event summary |
| `metadata_json` | TEXT | — | JSON blob |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Creation timestamp |

**Indexes:**

| Index Name | Columns | Notes |
|------------|---------|-------|
| `idx_events_session` | `session_id` | Lookup events by session |
| `idx_events_type` | `event_type` | Filter by event type |

---

## `git_commits`

Git commit metadata collected from local repositories via `cet sync`. No remote data is fetched.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `hash` | TEXT | NOT NULL | Full SHA commit hash |
| `short_hash` | TEXT | NOT NULL | Short (7-char) hash |
| `message` | TEXT | — | Commit message |
| `author` | TEXT | — | Author name |
| `authored_at` | TEXT | — | ISO 8601 commit timestamp |
| `branch` | TEXT | — | Branch name |
| `project_id` | TEXT | FK → projects(id) | Associated project |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Creation timestamp |

**Indexes:**

| Index Name | Columns | Notes |
|------------|---------|-------|
| `idx_git_commits_hash` | `hash` | Deduplication lookup |
| `idx_git_commits_project` | `project_id` | Filter by project |

---

## `session_commits`

Many-to-many relationship between sessions and git commits, with correlation confidence.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `session_id` | TEXT | NOT NULL, FK → sessions(id) | Session UUID |
| `commit_id` | TEXT | NOT NULL, FK → git_commits(id) | Commit UUID |
| `confidence` | REAL | NOT NULL, DEFAULT 0.0 | Correlation confidence (0–1) |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Creation timestamp |

**Primary key:** `(session_id, commit_id)`
**Indexes:** None beyond composite PRIMARY KEY.

---

## `test_outcomes`

Test result records ingested via `cet test-outcome`. Each record represents a single test command run.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `project_id` | TEXT | FK → projects(id) | Associated project |
| `session_id` | TEXT | FK → sessions(id) | Optional linked session |
| `commit_id` | TEXT | FK → git_commits(id) | Optional linked commit |
| `command` | TEXT | — | Test command (e.g., `npm test`) |
| `passed` | INTEGER | — | Number of passed tests |
| `failed` | INTEGER | — | Number of failed tests |
| `skipped` | INTEGER | — | Number of skipped tests |
| `duration_ms` | INTEGER | — | Duration in milliseconds |
| `raw_output_summary` | TEXT | — | Privacy-safe output summary |
| `run_at` | TEXT | — | ISO 8601 test run timestamp |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Creation timestamp |

**Indexes:**

| Index Name | Columns | Notes |
|------------|---------|-------|
| `idx_test_outcomes_session` | `session_id` | Lookup by session |
| `idx_test_outcomes_commit` | `commit_id` | Lookup by commit |

---

## `outcomes`

Manual outcome annotations recorded via `cet annotate` or the API. Each outcome is linked to a single session.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `session_id` | TEXT | NOT NULL, FK → sessions(id) | Parent session |
| `outcome_type` | TEXT | NOT NULL | Type: `manual` |
| `score` | REAL | — | Score 0–1 |
| `label` | TEXT | — | Outcome label (e.g., `shipped`, `rejected`) |
| `note` | TEXT | — | Free-text annotation note |
| `tags_json` | TEXT | — | JSON array of tags |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Creation timestamp |
| `updated_at` | TEXT | NOT NULL, DEFAULT now | Last update timestamp |

**Indexes:**

| Index Name | Columns | Notes |
|------------|---------|-------|
| `idx_outcomes_session` | `session_id` | Lookup by session |
| `idx_outcomes_type` | `outcome_type` | Filter by type |

---

## `correlations`

Correlation records connecting sessions to git commits, test outcomes, and manual outcomes. Generated by the correlation engine during `cet sync` and `cet test-outcome`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `session_id` | TEXT | NOT NULL, FK → sessions(id) | Parent session |
| `correlation_type` | TEXT | NOT NULL | Type: `git-commit`, `test-outcome`, or `manual-outcome` |
| `target_id` | TEXT | NOT NULL | ID of the correlated entity |
| `confidence` | REAL | NOT NULL, DEFAULT 0.0 | Confidence score 0–1 |
| `metadata_json` | TEXT | — | JSON with `reasons` array explaining confidence |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Creation timestamp |

**Indexes:**

| Index Name | Columns | Notes |
|------------|---------|-------|
| `idx_correlations_session` | `session_id` | Lookup by session |
| `idx_correlations_type` | `correlation_type` | Filter by type |

---

## `_migrations`

Internal migration tracking table.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Sequential ID |
| `name` | TEXT | NOT NULL, UNIQUE | Migration name (e.g., `001_core_schema`) |
| `applied_at` | TEXT | NOT NULL, DEFAULT now | When migration was applied |

**Indexes:** None beyond PRIMARY KEY. The `name` column has a UNIQUE constraint.

---

## Entity Relationships

```
projects ──────┬──── sessions ────── events
               │         │
               │         ├──── outcomes
               │         │
               │         ├──── correlations ──── (git_commits, test_outcomes, outcomes)
               │         │
               │         └──── session_commits ──── git_commits
               │
tools ─────────┘
```

- **sessions** belongs to **projects** and **tools**
- **events** belongs to **sessions**
- **outcomes** belongs to **sessions**
- **correlations** belongs to **sessions** and polymorphically references git_commits, test_outcomes, or outcomes via `target_id` + `correlation_type`
- **session_commits** is a many-to-many join between **sessions** and **git_commits**
- **test_outcomes** optionally references **sessions**, **git_commits**, and **projects**
- **git_commits** belongs to **projects**
