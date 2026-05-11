import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Storage } from '../src/storage.js';
import { ensureDataDir } from '../src/config.js';

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* Windows file locks */ }
}

function seedExportFixtures(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    INSERT OR IGNORE INTO projects (id, name) VALUES ('proj1', 'Project Alpha');
    INSERT OR IGNORE INTO tools (id, name, display_name) VALUES ('codex', 'codex', 'Codex');
    INSERT INTO sessions (id, source_tool_id, project_id, external_id, started_at, ended_at, duration_ms, summary, model, tokens_input, tokens_output, cost_estimate)
    VALUES ('sess1', 'codex', 'proj1', 'ext-1', '2025-01-15T10:00:00Z', '2025-01-15T11:00:00Z', 3600000, 'Implemented auth module', 'gpt-4', 5000, 2000, 0.15);
    INSERT INTO outcomes (id, session_id, outcome_type, score, label, note) VALUES ('out1', 'sess1', 'manual', 0.8, 'good', 'CANARY_LEAK_TEST_MARKER_ALPHA_ZERO in note');
    INSERT INTO test_outcomes (id, project_id, session_id, command, passed, failed, skipped, duration_ms, run_at, raw_output_summary)
    VALUES ('to1', 'proj1', 'sess1', 'npm test', 42, 0, 2, 15000, '2025-01-15T11:15:00Z', 'CANARY_LEAK_TEST_MARKER_BETA_ZERO raw summary');
  `);
  db.close();
}

describe('Export privacy (defence-in-depth)', () => {
  let tempDir: string;
  let dataDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-export-privacy-'));
    dataDir = ensureDataDir(join(tempDir, 'data'));
    // Create storage so DB+schema exist, then close
    const s = Storage.open({ dataDir });
    s.close();
    // Seed with canary data (simulating old unredacted DB)
    seedExportFixtures(join(dataDir, 'tracker.db'));
    storage = Storage.open({ dataDir });
  });

  afterEach(() => {
    storage?.close();
    safeCleanup(tempDir);
  });

  it('redacts outcome note on export', async () => {
    const { generateJsonExport } = await import('../src/api/export.js');
    const result = generateJsonExport(storage, {});

    const sess1 = result.sessions.find((s: Record<string, unknown>) => s.id === 'sess1');
    expect(sess1).toBeDefined();
    const outcomes = (sess1 as Record<string, unknown>).outcomes as Array<Record<string, unknown>>;
    expect(outcomes.length).toBe(1);
    const note = outcomes[0].note as string;
    // Canary should be redacted
    expect(note).not.toContain('CANARY_LEAK_TEST_MARKER_ALPHA_ZERO');
    expect(note).toContain('[REDACTED]');
  });

  it('markdown export does not leak secrets from outcomes', async () => {
    const { generateMarkdownExport } = await import('../src/api/export.js');
    const result = generateMarkdownExport(storage, {});

    // Markdown does not print notes inline, but verify no canary leaks
    expect(result).not.toContain('CANARY_LEAK_TEST_MARKER_ALPHA_ZERO');
  });

  it('redacts secrets on JSON export even with raw=true', async () => {
    const { generateJsonExport } = await import('../src/api/export.js');
    const result = generateJsonExport(storage, { raw: true });

    const sess1 = result.sessions.find((s: Record<string, unknown>) => s.id === 'sess1');
    expect(sess1).toBeDefined();
    const outcomes = (sess1 as Record<string, unknown>).outcomes as Array<Record<string, unknown>>;
    const note = outcomes[0].note as string;
    expect(note).not.toContain('CANARY_LEAK_TEST_MARKER_ALPHA_ZERO');
    expect(note).toContain('[REDACTED]');
  });
});
