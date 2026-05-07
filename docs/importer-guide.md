# Importer Guide

The importer framework normalizes session data from various AI coding tools into a common schema for storage, correlation, and scoring.

---

## ToolImporter Interface

Every importer must implement the `ToolImporter` interface:

```typescript
interface ToolImporter {
  /** Tool identifier matching the tools table id. */
  readonly toolId: string;

  /** Human-readable display name. */
  readonly displayName: string;

  /**
   * Detect whether the given path contains recognizable data for this tool.
   * Returns true if the importer should attempt to read from this path.
   */
  canHandle(sourcePath: string): boolean;

  /**
   * Parse and normalize sessions from the source path.
   * Does NOT write to storage — returns normalized records only.
   */
  parse(options: ImportOptions): ImportResult;
}
```

**Contract:**
- `canHandle()` must be fast and non-destructive — it checks file/directory structure without modifying anything
- `parse()` returns normalized records but does NOT write to the database. Writing is handled by the registry's `runImport()` function
- `parse()` should return accurate `imported`, `skipped`, and `errors` counts
- Error messages should be privacy-safe (no raw prompt content, no API keys)

### Supporting Types

```typescript
interface NormalizedSession {
  externalId: string;
  sourceToolId: string;
  projectId?: string;
  startedAt?: string;       // ISO 8601
  endedAt?: string;         // ISO 8601
  durationMs?: number;
  summary?: string;
  model?: string;
  tokensInput?: number;
  tokensOutput?: number;
  costEstimate?: number;
  metadata?: Record<string, unknown>;
  events?: NormalizedEvent[];
}

interface NormalizedEvent {
  eventType: string;
  occurredAt?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

interface ImportResult {
  sourceToolId: string;
  sourcePath: string;
  imported: number;
  skipped: number;
  errors: number;
  errorDetails: string[];
  sessions: NormalizedSession[];
}

interface ImportOptions {
  sourcePath: string;        // Absolute path to source directory or file
  dryRun?: boolean;          // Only validate; do not write
  since?: string;            // Only sessions newer than this ISO timestamp
}
```

---

## canHandle / parse Pattern

Each importer implements two methods that form the discovery and parsing pipeline:

### canHandle(sourcePath)

Determines if an importer can process the given path. Examples of detection logic:

- **Claude Code**: checks for `.claude` directory or projects subdirectory
- **Codex**: checks for `.codex` directory or presence of codex-related `.jsonl`/`.log` files
- **OpenCode**: checks for `opencode` directory in AppData
- **Cursor**: checks for `Cursor` directory in AppData or `.cursor` in home
- **Factory Droid**: checks for `.factory` directory

The method must:
- Return quickly (no expensive parsing)
- Be safe against non-existent paths
- Not throw exceptions for inaccessible paths

### parse(options)

Performs the actual parsing. The method:
1. Scans the source path for supported files (`.jsonl`, `.json`, `.log`)
2. Reads records and groups them into sessions
3. Normalizes fields (timestamps, token counts, summaries)
4. Returns an `ImportResult` with the parsed sessions

The registry's `runImport()` function then:
1. Applies privacy redaction to summaries, metadata, and events
2. Optionally writes to SQLite (idempotent upsert)

---

## Registration

Importers are registered via the registry module:

```typescript
import { registerImporter } from './registry.js';

// Register a custom importer
registerImporter(new MyCustomImporter());
```

**Built-in importers** are auto-registered when `src/importers/index.ts` is loaded via `registerAllImporters()`:

| Tool | Class | Source |
|------|-------|--------|
| Claude Code | `ClaudeCodeImporter` | `src/importers/claude-code.ts` |
| Codex | `CodexImporter` | `src/importers/codex.ts` |
| OpenCode | `OpenCodeImporter` | `src/importers/opencode.ts` |
| Cursor | `CursorImporter` | `src/importers/cursor.ts` |
| Factory Droid | `FactoryDroidImporter` | `src/importers/factory-droid.ts` |

### Registry API

```typescript
// Register an importer
registerImporter(importer: ToolImporter): void

// Get all registered importers
getImporters(): ToolImporter[]

// Get a specific importer by tool id
getImporter(toolId: string): ToolImporter | undefined

// Discover which importers can handle given source paths
discoverImporters(sourcePaths: string[]): Array<{ importer: ToolImporter; path: string }>

// Run a full import (parse + redact + write)
runImport(importer: ToolImporter, options: ImportOptions, storage?: Storage): ImportResult

// Import all discovered sources
importAll(sourcePaths: string[], options?, storage?): ImportResult[]

// Import from a specific tool
importFromTool(toolId: string, sourcePath: string, options?, storage?): ImportResult

// Import from a fixture JSON file
runFixtureImport(fixturePath: string, storage?: Storage): ImportResult
```

---

## Privacy Redaction

All parsed sessions pass through the privacy redaction pipeline before storage:

1. **Summary redaction**: `redactSecrets()` removes API keys, tokens, JWTs, and canary markers
2. **Metadata redaction**: `redactMetadata()` redacts sensitive keys (apiKey, secret, password, token, auth) regardless of casing convention, and recursively scans nested objects
3. **Event redaction**: Each event's summary and metadata are individually redacted
4. **Output sanitization**: `sanitizeForOutput()` truncates long strings and redacts secrets for terminal output

This happens automatically in `runImport()` — individual importers do not need to handle redaction.

See [privacy.md](privacy.md) for full details.

---

## Path Safety

The path safety module protects against malicious or accidental path traversal:

```typescript
// Verify target is within root directory
safeResolvePath(root: string, target: string): string
// Throws PathSafetyError if target escapes root

// Detect symlink escape
assertNoSymlinkEscape(root: string, target: string): void
// Throws PathSafetyError if symlink points outside root

// Safe directory listing (skips symlink escapes)
safeReadDir(root: string, dirPath: string): string[]

// Safe lstat with escape detection
safeLstat(root: string, target: string): Stats
```

All importers use these utilities when scanning directories and files to ensure data cannot be read from outside the designated source path.

---

## Supported File Formats

All importers support these file formats:

| Extension | Format | Notes |
|-----------|--------|-------|
| `.jsonl` | JSON Lines (one JSON object per line) | Read via `readJsonl()` utility |
| `.json` | JSON (object or array) | Parsed via `JSON.parse()` |
| `.log` | Treated as JSONL | Same as `.jsonl` parsing |

Malformed lines in JSONL files are skipped with a warning and counted in `errors`. Empty files are skipped.

---

## Adding a New Importer

To add support for a new AI coding tool:

1. Create a new file in `src/importers/` (e.g., `my-tool.ts`)
2. Implement the `ToolImporter` interface
3. Add registration to `registerAllImporters()` in `registry.ts`
4. Add the tool ID to `getDefaultSourcePaths()` in `commands/import.ts`
5. Add the tool to the default tools list in `commands/init.ts`
6. Write tests covering `canHandle` and `parse` for your importer
