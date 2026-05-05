import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Storage } from '../src/storage.js';
import { ensureDataDir } from '../src/config.js';
import { ClaudeCodeImporter } from '../src/importers/claude-code.js';
import { CodexImporter } from '../src/importers/codex.js';
import { OpenCodeImporter } from '../src/importers/opencode.js';
import { FactoryDroidImporter } from '../src/importers/factory-droid.js';
import { CursorImporter } from '../src/importers/cursor.js';
import {
  registerAllImporters,
  getImporters,
  discoverImporters,
  runImport,
  runFixtureImport,
  importFromTool,
  importAll,
} from '../src/importers/registry.js';
import { readJsonl } from '../src/importers/utils.js';
import { redactSecrets, findCanaryLeaks, sanitizeForOutput, CANARY_SECRETS, ALL_CANARIES } from '../src/importers/privacy.js';
import { safeResolvePath, PathSafetyError } from '../src/importers/path-safety.js';

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures');

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* Windows file locks */ }
}

function createTestStorage(tempDir: string): Storage {
  const dataDir = ensureDataDir(join(tempDir, 'data'));
  const storage = Storage.open({ dataDir });
  // Seed default tools (normally done by handleInit)
  const db = storage.db;
  const defaultTools = [
    { id: 'codex', name: 'codex', display_name: 'Codex' },
    { id: 'opencode', name: 'opencode', display_name: 'OpenCode' },
    { id: 'factory-droid', name: 'factory-droid', display_name: 'Factory Droid' },
    { id: 'claude-code', name: 'claude-code', display_name: 'Claude Code' },
    { id: 'cursor', name: 'cursor', display_name: 'Cursor' },
    { id: 'fixture', name: 'fixture', display_name: 'Fixture Import' },
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)');
  const insertAll = db.transaction(() => {
    for (const t of defaultTools) insert.run(t.id, t.name, t.display_name);
  });
  insertAll();
  return storage;
}

function getSessionCount(db: Database.Database): number {
  return (db.prepare('SELECT count(*) as cnt FROM sessions').get() as { cnt: number }).cnt;
}

// ─── Privacy utilities ─────────────────────────────────────────────────────────

describe('Privacy utilities', () => {
  it('redactSecrets replaces known patterns', () => {
    const input = 'Use sk-abc1234567890123456789012345 for auth';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-abc1234567890123456789012345');
    expect(result).toContain('[REDACTED]');
  });

  it('findCanaryLeaks detects embedded canaries', () => {
    const text = `Found key: ${CANARY_SECRETS.canary1} in source`;
    const leaks = findCanaryLeaks(text);
    expect(leaks).toContain(CANARY_SECRETS.canary1);
  });

  it('findCanaryLeaks returns empty for clean text', () => {
    const leaks = findCanaryLeaks('This is clean text with no secrets');
    expect(leaks).toEqual([]);
  });

  it('sanitizeForOutput truncates long strings', () => {
    const long = 'x'.repeat(500);
    const result = sanitizeForOutput(long, 100);
    expect(result.length).toBeLessThan(500);
    expect(result).toContain('[truncated]');
  });
});

// ─── Path safety ───────────────────────────────────────────────────────────────

describe('Path safety', () => {
  it('safeResolvePath allows paths within root', () => {
    const root = '/some/root';
    expect(safeResolvePath(root, 'subdir/file.json')).toBeTruthy();
  });

  it('safeResolvePath rejects path traversal with ..', () => {
    const root = '/some/root';
    expect(() => safeResolvePath(root, '../../etc/passwd')).toThrow(PathSafetyError);
  });
});

// ─── JSONL parser ──────────────────────────────────────────────────────────────

describe('readJsonl', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'cet-jsonl-')); });
  afterEach(() => { safeCleanup(tempDir); });

  it('parses valid JSONL file', () => {
    const filePath = join(tempDir, 'test.jsonl');
    writeFileSync(filePath, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const { records, errors } = readJsonl(filePath);
    expect(records).toHaveLength(3);
    expect(errors).toHaveLength(0);
  });

  it('skips malformed lines', () => {
    const filePath = join(tempDir, 'test.jsonl');
    writeFileSync(filePath, '{"a":1}\nnot json\n{"c":3}\n');
    const { records, errors } = readJsonl(filePath);
    expect(records).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });
});

// ─── Claude Code importer ──────────────────────────────────────────────────────

describe('Claude Code importer', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'cet-claude-')); });
  afterEach(() => { safeCleanup(tempDir); });

  it('canHandle detects Claude Code fixtures', () => {
    expect(new ClaudeCodeImporter().canHandle(join(FIXTURES_DIR, 'claude-code'))).toBe(true);
  });

  it('canHandle rejects unrelated paths', () => {
    expect(new ClaudeCodeImporter().canHandle(join(FIXTURES_DIR, 'codex'))).toBe(false);
  });

  it('parses Claude Code sessions from fixture (VAL-CLI-017)', () => {
    const result = new ClaudeCodeImporter().parse({ sourcePath: join(FIXTURES_DIR, 'claude-code') });
    expect(result.errors).toBe(0);
    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    expect(result.sessions[0].sourceToolId).toBe('claude-code');
    expect(result.sessions[0].externalId).toBeTruthy();
  });

  it('handles missing source path gracefully', () => {
    const result = new ClaudeCodeImporter().parse({ sourcePath: join(tempDir, 'nonexistent') });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.sessions).toHaveLength(0);
  });
});

// ─── Codex importer ────────────────────────────────────────────────────────────

describe('Codex importer', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'cet-codex-')); });
  afterEach(() => { safeCleanup(tempDir); });

  it('canHandle detects Codex fixtures', () => {
    expect(new CodexImporter().canHandle(join(FIXTURES_DIR, 'codex'))).toBe(true);
  });

  it('parses Codex sessions from fixture (VAL-CLI-014)', () => {
    const result = new CodexImporter().parse({ sourcePath: join(FIXTURES_DIR, 'codex') });
    expect(result.errors).toBe(0);
    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    expect(result.sessions[0].sourceToolId).toBe('codex');
  });

  it('captures token counts when available', () => {
    const result = new CodexImporter().parse({ sourcePath: join(FIXTURES_DIR, 'codex') });
    const session = result.sessions.find((s) => s.tokensInput && s.tokensInput > 0);
    expect(session).toBeTruthy();
    expect(session!.tokensInput).toBeGreaterThan(0);
  });

  it('handles missing source path gracefully', () => {
    const result = new CodexImporter().parse({ sourcePath: join(tempDir, 'nonexistent') });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.sessions).toHaveLength(0);
  });
});

// ─── OpenCode importer ─────────────────────────────────────────────────────────

describe('OpenCode importer', () => {
  it('canHandle detects OpenCode fixtures', () => {
    expect(new OpenCodeImporter().canHandle(join(FIXTURES_DIR, 'opencode'))).toBe(true);
  });

  it('parses OpenCode sessions from fixture (VAL-CLI-015)', () => {
    const result = new OpenCodeImporter().parse({ sourcePath: join(FIXTURES_DIR, 'opencode') });
    expect(result.errors).toBe(0);
    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    expect(result.sessions[0].sourceToolId).toBe('opencode');
  });
});

// ─── Factory Droid importer ────────────────────────────────────────────────────

describe('Factory Droid importer', () => {
  it('canHandle detects Factory Droid fixtures', () => {
    expect(new FactoryDroidImporter().canHandle(join(FIXTURES_DIR, 'factory-droid'))).toBe(true);
  });

  it('parses Factory Droid sessions from fixture (VAL-CLI-016)', () => {
    const result = new FactoryDroidImporter().parse({ sourcePath: join(FIXTURES_DIR, 'factory-droid') });
    expect(result.errors).toBe(0);
    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    expect(result.sessions[0].sourceToolId).toBe('factory-droid');
  });
});

// ─── Cursor importer ───────────────────────────────────────────────────────────

describe('Cursor importer', () => {
  it('canHandle detects Cursor fixtures', () => {
    expect(new CursorImporter().canHandle(join(FIXTURES_DIR, 'cursor'))).toBe(true);
  });

  it('parses Cursor sessions from fixture (VAL-CLI-018)', () => {
    const result = new CursorImporter().parse({ sourcePath: join(FIXTURES_DIR, 'cursor') });
    expect(result.errors).toBe(0);
    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    expect(result.sessions[0].sourceToolId).toBe('cursor');
  });

  it('captures token counts when available', () => {
    const result = new CursorImporter().parse({ sourcePath: join(FIXTURES_DIR, 'cursor') });
    const session = result.sessions.find((s) => s.tokensInput && s.tokensInput > 0);
    expect(session).toBeTruthy();
    expect(session!.tokensInput).toBeGreaterThan(0);
  });
});

// ─── Registry / discovery ──────────────────────────────────────────────────────

describe('Importer registry', () => {
  beforeEach(() => { registerAllImporters(); });

  it('discovers all 5 importers from fixture paths (VAL-IMPORT-001)', () => {
    const paths = [
      join(FIXTURES_DIR, 'claude-code'), join(FIXTURES_DIR, 'codex'),
      join(FIXTURES_DIR, 'opencode'), join(FIXTURES_DIR, 'factory-droid'),
      join(FIXTURES_DIR, 'cursor'),
    ];
    const discovered = discoverImporters(paths);
    expect(discovered.length).toBe(5);
    const toolIds = discovered.map((d) => d.importer.toolId).sort();
    expect(toolIds).toEqual(['claude-code', 'codex', 'cursor', 'factory-droid', 'opencode']);
  });

  it('returns empty for nonexistent paths', () => {
    expect(discoverImporters(['/nonexistent/path'])).toHaveLength(0);
  });

  it('getImporters returns all 5 registered importers', () => {
    expect(getImporters().length).toBe(5);
  });
});

// ─── Malformed data ────────────────────────────────────────────────────────────

describe('Malformed data handling', () => {
  it('skips malformed JSONL lines without crashing (VAL-IMPORT-007)', () => {
    const { records, errors } = readJsonl(join(FIXTURES_DIR, 'malformed', 'bad-jsonl.jsonl'));
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('reports malformed JSON file as error', () => {
    const result = new CodexImporter().parse({ sourcePath: join(FIXTURES_DIR, 'malformed', 'broken.json') });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.sessions).toHaveLength(0);
  });

  it('skips empty files', () => {
    const result = new CodexImporter().parse({ sourcePath: join(FIXTURES_DIR, 'malformed', 'empty.jsonl') });
    expect(result.sessions).toHaveLength(0);
  });
});

// ─── Missing import path (VAL-CLI-011) ─────────────────────────────────────────

describe('VAL-CLI-011: Missing import path fails safely', () => {
  it('reports error for nonexistent source path', () => {
    const result = new CodexImporter().parse({ sourcePath: '/nonexistent/path/to/codex/data' });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.errorDetails[0]).toContain('not found');
    expect(result.sessions).toHaveLength(0);
  });
});

// ─── Fixture import ────────────────────────────────────────────────────────────

describe('Fixture import', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-fixture-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('imports sessions from fixture JSON (VAL-CLI-008)', () => {
    const result = runFixtureImport(join(FIXTURES_DIR, 'sessions-fixture.json'), storage);
    expect(result.errors).toBe(0);
    expect(result.imported).toBe(3);
    expect(getSessionCount(storage.db)).toBe(3);
  });

  it('is idempotent on second import (VAL-CLI-009)', () => {
    runFixtureImport(join(FIXTURES_DIR, 'sessions-fixture.json'), storage);
    const count1 = getSessionCount(storage.db);
    runFixtureImport(join(FIXTURES_DIR, 'sessions-fixture.json'), storage);
    expect(getSessionCount(storage.db)).toBe(count1);
  });

  it('reports error for missing fixture file (VAL-CLI-011)', () => {
    const result = runFixtureImport('/nonexistent/fixture.json', storage);
    expect(result.errors).toBe(1);
  });

  it('reports error for malformed fixture file (VAL-CLI-012)', () => {
    const result = runFixtureImport(join(FIXTURES_DIR, 'malformed', 'broken.json'), storage);
    expect(result.errors).toBeGreaterThan(0);
    expect(getSessionCount(storage.db)).toBe(0);
  });

  it('handles mixed valid/invalid records (VAL-CLI-013)', () => {
    const result = runFixtureImport(join(FIXTURES_DIR, 'malformed', 'mixed-validity.json'), storage);
    expect(result.imported).toBe(2);
    expect(result.errors + result.skipped).toBeGreaterThan(0);
  });
});

// ─── Dry-run (VAL-CLI-020) ─────────────────────────────────────────────────────

describe('VAL-CLI-020: Import dry-run is non-mutating', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-dryrun-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('dry-run reports sessions without writing to DB', () => {
    const result = runImport(new CodexImporter(), {
      sourcePath: join(FIXTURES_DIR, 'codex'), dryRun: true,
    }, storage);
    expect(result.sessions.length).toBeGreaterThanOrEqual(2);
    expect(getSessionCount(storage.db)).toBe(0);
  });
});

// ─── Idempotent / incremental (VAL-IMPORT-005, VAL-IMPORT-006) ─────────────────

describe('Idempotent and incremental imports', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-idempotent-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('does not duplicate sessions on re-import (VAL-IMPORT-005)', () => {
    const importer = new CodexImporter();
    runImport(importer, { sourcePath: join(FIXTURES_DIR, 'codex') }, storage);
    const count1 = getSessionCount(storage.db);
    runImport(importer, { sourcePath: join(FIXTURES_DIR, 'codex') }, storage);
    expect(getSessionCount(storage.db)).toBe(count1);
  });

  it('preserves existing sessions when importing new data (VAL-IMPORT-006)', () => {
    runImport(new CodexImporter(), { sourcePath: join(FIXTURES_DIR, 'codex') }, storage);
    const countAfterCodex = getSessionCount(storage.db);
    runImport(new ClaudeCodeImporter(), { sourcePath: join(FIXTURES_DIR, 'claude-code') }, storage);
    expect(getSessionCount(storage.db)).toBeGreaterThan(countAfterCodex);
    const codexSessions = storage.db.prepare('SELECT count(*) as cnt FROM sessions WHERE source_tool_id = ?').get('codex') as { cnt: number };
    expect(codexSessions.cnt).toBe(countAfterCodex);
  });
});

// ─── Source file non-mutation ───────────────────────────────────────────────────

describe('Source file non-mutation', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-mutation-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('does not modify source files after import (VAL-CLI-018)', () => {
    const srcFixture = join(FIXTURES_DIR, 'cursor', 'sessions.jsonl');
    const tempFixture = join(tempDir, 'sessions.jsonl');
    copyFileSync(srcFixture, tempFixture);
    const originalContent = readFileSync(tempFixture, 'utf-8');
    runImport(new CursorImporter(), { sourcePath: tempDir }, storage);
    expect(readFileSync(tempFixture, 'utf-8')).toBe(originalContent);
  });
});

// ─── Normalize into common schema (VAL-IMPORT-004) ─────────────────────────────

describe('VAL-IMPORT-004: All tools normalize into common schema', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-normalize-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  const tools = [
    { id: 'codex', Importer: CodexImporter, dir: 'codex' },
    { id: 'claude-code', Importer: ClaudeCodeImporter, dir: 'claude-code' },
    { id: 'opencode', Importer: OpenCodeImporter, dir: 'opencode' },
    { id: 'factory-droid', Importer: FactoryDroidImporter, dir: 'factory-droid' },
    { id: 'cursor', Importer: CursorImporter, dir: 'cursor' },
  ];

  for (const tool of tools) {
    it(`normalizes ${tool.id} sessions into common schema`, () => {
      const result = runImport(new tool.Importer(), { sourcePath: join(FIXTURES_DIR, tool.dir) }, storage);
      expect(result.imported).toBeGreaterThanOrEqual(1);
      expect(result.errors).toBe(0);
      const sessions = storage.db.prepare('SELECT * FROM sessions WHERE source_tool_id = ?').all(tool.id) as Record<string, unknown>[];
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      for (const s of sessions) {
        expect(s.source_tool_id).toBe(tool.id);
        expect(s.external_id).toBeTruthy();
        expect(s.started_at).toBeTruthy();
        expect(s.summary).toBeTruthy();
      }
    });
  }
});

// ─── importAll ─────────────────────────────────────────────────────────────────

describe('importAll', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-importall-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  const allPaths = [
    join(FIXTURES_DIR, 'claude-code'), join(FIXTURES_DIR, 'codex'),
    join(FIXTURES_DIR, 'opencode'), join(FIXTURES_DIR, 'factory-droid'),
    join(FIXTURES_DIR, 'cursor'),
  ];

  it('imports sessions from all 5 tool fixtures (VAL-CLI-008)', () => {
    const results = importAll(allPaths, {}, storage);
    expect(results.length).toBe(5);
    for (const r of results) { expect(r.errors).toBe(0); expect(r.imported).toBeGreaterThanOrEqual(1); }
    expect(getSessionCount(storage.db)).toBeGreaterThanOrEqual(10);
  });

  it('is idempotent when running importAll twice (VAL-CLI-009)', () => {
    importAll(allPaths, {}, storage);
    const count1 = getSessionCount(storage.db);
    importAll(allPaths, {}, storage);
    expect(getSessionCount(storage.db)).toBe(count1);
  });
});

// ─── Privacy redaction (VAL-CLI-021, VAL-IMPORT-008, VAL-IMPORT-012) ───────────

describe('Privacy redaction in imports', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-privacy-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  const canaryTests = [
    { id: 'codex', Importer: CodexImporter, dir: 'codex' },
    { id: 'claude-code', Importer: ClaudeCodeImporter, dir: 'claude-code' },
    { id: 'opencode', Importer: OpenCodeImporter, dir: 'opencode' },
    { id: 'factory-droid', Importer: FactoryDroidImporter, dir: 'factory-droid' },
    { id: 'cursor', Importer: CursorImporter, dir: 'cursor' },
  ];

  for (const t of canaryTests) {
    it(`redacts canary secrets from ${t.id} sessions`, () => {
      runImport(new t.Importer(), { sourcePath: join(FIXTURES_DIR, t.dir) }, storage);
      const sessions = storage.db.prepare('SELECT summary FROM sessions WHERE source_tool_id = ?').all(t.id) as { summary: string }[];
      for (const s of sessions) {
        expect(findCanaryLeaks(s.summary || '')).toEqual([]);
      }
    });
  }

  it('no canary strings exist in any session summary or metadata (VAL-IMPORT-012)', () => {
    importAll([
      join(FIXTURES_DIR, 'claude-code'), join(FIXTURES_DIR, 'codex'),
      join(FIXTURES_DIR, 'opencode'), join(FIXTURES_DIR, 'factory-droid'),
      join(FIXTURES_DIR, 'cursor'),
    ], {}, storage);
    const allSessions = storage.db.prepare('SELECT summary, metadata_json FROM sessions').all() as { summary: string; metadata_json: string }[];
    for (const s of allSessions) {
      for (const canary of ALL_CANARIES) {
        expect(s.summary || '').not.toContain(canary);
        expect(s.metadata_json || '').not.toContain(canary);
      }
    }
  });
});

// ─── importFromTool ────────────────────────────────────────────────────────────

describe('importFromTool', () => {
  let tempDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-fromtool-'));
    storage = createTestStorage(tempDir);
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('imports from a specific tool by id', () => {
    const result = importFromTool('codex', join(FIXTURES_DIR, 'codex'), {}, storage);
    expect(result.imported).toBeGreaterThanOrEqual(2);
    expect(result.errors).toBe(0);
  });

  it('returns error for unknown tool id', () => {
    const result = importFromTool('nonexistent', '/some/path');
    expect(result.errors).toBe(1);
  });
});

// ─── CLI integration ───────────────────────────────────────────────────────────

describe('CLI import command', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'cet-cli-import-')); });
  afterEach(() => { safeCleanup(tempDir); });

  function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const cliPath = join(process.cwd(), 'bin', 'cli.js');
    try {
      const stdout = execFileSync('node', [cliPath, ...args], { encoding: 'utf-8', timeout: 15000 });
      return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim(), exitCode: e.status ?? 1 };
    }
  }

  it('imports fixture data via CLI (VAL-CLI-008)', () => {
    runCli(['init', '-d', tempDir]);
    const result = runCli(['import', '-d', tempDir, '--fixture', join(FIXTURES_DIR, 'sessions-fixture.json')]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/import|session/i);
    const db = new Database(join(tempDir, 'tracker.db'), { readonly: true });
    try {
      const count = db.prepare('SELECT count(*) as cnt FROM sessions').get() as { cnt: number };
      expect(count.cnt).toBeGreaterThanOrEqual(1);
    } finally { db.close(); }
  });

  it('exits non-zero for nonexistent import source (VAL-CLI-011)', () => {
    runCli(['init', '-d', tempDir]);
    const result = runCli(['import', '-d', tempDir, '--tool', 'codex', '--source', join(tempDir, 'nonexistent')]);
    expect(result.exitCode).not.toBe(0);
  });

  it('dry-run does not write to database (VAL-CLI-020)', () => {
    runCli(['init', '-d', tempDir]);
    const result = runCli(['import', '-d', tempDir, '--dry-run']);
    expect(result.exitCode).toBe(0);
    const db = new Database(join(tempDir, 'tracker.db'), { readonly: true });
    try {
      expect((db.prepare('SELECT count(*) as cnt FROM sessions').get() as { cnt: number }).cnt).toBe(0);
    } finally { db.close(); }
  });
});