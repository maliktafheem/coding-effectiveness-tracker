# Privacy

The Coding Effectiveness Tracker is designed as a **local-first** tool. All data processing, storage, and analysis happens on the user's machine. There is no cloud backend, no telemetry, and no hosted service.

---

## Core Principles

1. **All data stays local** — no data is sent to any external server
2. **No telemetry** — the tool does not collect usage statistics, crash reports, or analytics
3. **No hosted backend** — there is no cloud component; the API server runs on the same machine
4. **Explicit opt-in for discovery** — auto-scanning tool directories requires `--discover` flag
5. **Redaction by default** — known secret patterns, tokens, and sensitive metadata keys are redacted before storage; see [Limitations and Known Gaps](#limitations-and-known-gaps) for what may not be caught
6. **Transparent handling** — every command prints a privacy statement on completion

---

## Local-First Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Your Machine                        │
│                                                        │
│   CLI ──→ SQLite Database ──→ Scoring Engine          │
│              (tracker.db)            │                │
│                                     ▼                  │
│   API Server (127.0.0.1 only) ←── Dashboard           │
│                                                        │
│   Importers read from local tool directories only      │
│   Git sync reads local repo (no remote fetch)          │
└──────────────────────────────────────────────────────┘
```

- The database (`tracker.db`) is a local SQLite file in the data directory
- The API server binds **exclusively** to `127.0.0.1` (loopback)
- The React dashboard is served as static files from the local machine
- No outbound network connections are made
- No user data leaves the machine

---

## No Telemetry

- The tool does not contain any analytics SDK, tracking pixel, or telemetry call
- No usage statistics are collected or transmitted
- No crash reports are sent to external services
- No feature flags that phone home
- The `package.json` has no dependencies on analytics or telemetry libraries

---

## Loopback-Only Binding

The API server (`cet serve`) enforces loopback-only binding:

- Default host: `127.0.0.1`
- The server throws on startup if any non-loopback address is specified
- CORS protection blocks cross-origin write mutations (POST, PATCH, DELETE) for non-loopback origins
- The server does not support HTTPS (not needed for loopback)
- Default port: `43187` (configurable via `--port`)

---

## Redaction Pipeline

All sensitive content passes through the redaction pipeline before being stored in the database or displayed in terminal output.

### Secret Pattern Redaction

The `redactSecrets()` function detects and replaces common secret formats:

| Pattern | Example |
|---------|---------|
| API keys with common prefixes | `sk-abc123...`, `sk_live_...`, `pk_test_...` |
| Key/value assignments | `apiKey=abc123...`, `token: xyz...` |
| Bearer tokens | `Bearer eyJhbGci...` |
| JWT tokens | `eyJXXX.eyJYYY.ZZZ` |

Matched content is replaced with `[REDACTED]`.

### Canary-Aware Redaction

Test fixtures contain canary strings to verify redaction is working:

```
CANARY_LEAK_TEST_MARKER_ALPHA_ZERO
CANARY_LEAK_TEST_MARKER_BETA_ZERO
CANARY_LEAK_TEST_MARKER_GAMMA_ZERO
CANARY_LEAK_TEST_MARKER_DELTA_ZERO
```

The `findCanaryLeaks()` function scans output for unredacted canaries. All tests verify that canaries do not appear in terminal output, SQLite summary fields, or export files.

### Sensitive Metadata Key Redaction

The `redactMetadata()` function recursively scans metadata objects and redacts values for known sensitive keys, regardless of casing convention:

| Normalized Key | Matches |
|---------------|---------|
| `apikey` | `apiKey`, `api_key`, `API_KEY`, `api-key` |
| `secret` | `secret`, `SECRET`, `mySecret` |
| `token` | `token`, `TOKEN`, `accessToken`, `access-token` |
| `password` | `password`, `PASSWORD`, `myPassword` |
| `auth` | `auth`, `AUTH`, `authorization` |

The normalization strips separators (hyphens, underscores, dots) and lowercases before matching, so `apiKey`, `api_key`, `api-key`, and `API_KEY` all match the `apikey` stem.

### Terminal Output Sanitization

The `sanitizeForOutput()` function:
1. Applies secret pattern redaction
2. Truncates strings longer than 200 characters (append `...[truncated]`)
3. Used for all error messages and verbose output

### Metadata Exclusion in Exports

Session metadata (the `metadata_json` field containing full tool session data) is **excluded from exports by default**. To include it, the caller must explicitly pass `raw=true` as a query parameter to `/api/export/json` or `/api/export/markdown`.

---

## Canary Testing

Canary strings are embedded in test fixtures to provide automated verification that the redaction pipeline works correctly. Tests in `tests/*.test.ts` verify that:

1. Terminal output from `init` and `import` does not contain canary strings
2. SQLite summary fields do not contain canary strings
3. JSON and Markdown export files do not contain canary strings
4. Verbose import output does not leak canary secrets
5. Report output does not contain canary strings

These tests ensure that if the redaction pipeline has a regression, it will be caught before any sensitive data could be exposed.

---

## Limitations and Known Gaps

The redaction pipeline is a **pattern-matching blocklist**, not a semantic classifier. It can only catch what it has been explicitly taught to recognize. Patterns must be known in advance to match.

### What IS caught

The patterns described in the [Redaction Pipeline](#redaction-pipeline) section above cover:

| Category | Examples caught |
|----------|----------------|
| API keys with common prefixes | `sk-`, `sk_live_`, `sk_test_`, `pk_live_`, `pk_test_` |
| Key/value assignments with known sensitive names | `apiKey=...`, `token: ...`, `secret=...`, `password=...` |
| Bearer tokens | `Bearer <credential>` |
| JWT-shaped strings | `eyJ...eyJ...` three-part structure |
| Known sensitive metadata keys | `apikey`, `token`, `secret`, `password`, `auth`, `authorization`, `accesstoken`, `authtoken` (all casing variants) |

### What MAY slip through

- **Novel secret formats without a recognized prefix** — a new vendor's API key that uses an unfamiliar structure (e.g., `vnd_abc123xyz...`) will not match any existing pattern and will pass through unredacted.
- **High-entropy opaque strings in free text** — a random-looking credential embedded in a sentence without a keyword like `key=`, `token=`, or `Bearer` will not be caught.
- **Custom tool-specific metadata keys** — any metadata key not in the `SENSITIVE_KEY_STEMS` set (`apikey`, `accesstoken`, `authtoken`, `token`, `secret`, `password`, `authorization`, `auth`) will have its value passed through `redactSecrets()` but will not be treated as unconditionally sensitive. A key like `my_internal_credential` or `x-custom-auth-header` will not match.
- **User-written content in session summaries** — if a session summary or annotation contains a secret that lacks a recognized prefix or keyword context, it will be stored as-is.

### `metadata_json` and raw exports

Full session metadata (the `metadata_json` field) is **excluded from exports by default**. Passing `raw=true` to `/api/export/json` or `/api/export/markdown` includes it. The raw metadata may contain fields that were not redacted because their keys are not in the sensitive-key list. Inspect raw exports carefully before sharing.

### Practical recommendation

Treat all exports as **sensitive by default**. Review the content before sharing with colleagues, pasting into issue trackers, or uploading anywhere. The redaction pipeline reduces risk but does not eliminate it.

---

## Reporting a Redaction Gap

If you find a secret format or metadata key that slips through the redaction pipeline, please report it privately. Follow the process described in [SECURITY.md](../SECURITY.md) — open a private vulnerability report via the GitHub Security tab rather than a public issue. Privacy gaps (content that should be redacted but is not) are treated as security issues under the same process.

---

## Import Privacy

- **No auto-discovery without opt-in**: `cet import` requires `--discover` to scan default tool directories
- **Explicit source paths**: Users can specify exact paths with `--source` or `--tool + --source`
- **Privacy statement**: Every import operation prints: *"Privacy: All data stays local. Sensitive content is redacted by default."*
- **Tool data stays local**: Importers read from local files only; no data is sent to any external service

---

## Git Sync Privacy

- **Local-only**: `cet sync` runs `git log --all` locally — no `git fetch`, `git push`, or remote API calls
- **No commit content uploaded**: Commit messages and diffs stay on disk and in the local SQLite database
- **Privacy statement**: Every sync operation prints: *"Privacy: All data stays local. No remote git calls were made."*

---

## Test Outcome Privacy

- **Local-only**: `cet test-outcome` reads from local files only
- **No CI/API calls**: No external test runners or CI services are contacted
- **Raw output is summarized**: Test output summaries are stored, not full logs
- **Privacy statement**: Every test-outcome operation prints: *"Privacy: All data stays local. No remote CI/API calls were made."*

---

## Data Directory

Default locations:

| Platform | Path |
|----------|------|
| Windows | `%LOCALAPPDATA%\coding-effectiveness-tracker` |
| macOS/Linux | `~/.coding-effectiveness-tracker` |

Override via `--data-dir <path>` flag or `CET_DATA_DIR` environment variable.

The data directory contains the SQLite database (`tracker.db`) and subdirectories for importers, exports, and correlations.
