import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Storage } from '../src/storage.js';
import { ensureDataDir, ensureInitialized } from '../src/config.js';

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* Windows file locks */ }
}

function seedSession(dataDir: string): void {
  // Use ensureInitialized to create DB + schema, then seed
  ensureInitialized(dataDir);
  const storage = Storage.open({ dataDir });
  try {
    const db = storage.db;
    // Ensure tool exists
    db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('codex', 'codex', 'Codex');
    // Seed session
    db.prepare(
      'INSERT OR IGNORE INTO sessions (id, source_tool_id, external_id, started_at) VALUES (?, ?, ?, ?)'
    ).run('test-session-1', 'codex', 'ext-1', '2026-01-01T00:00:00Z');
  } finally {
    storage.close();
  }
}

describe('handleAnnotate privacy', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-annot-privacy-'));
    dataDir = ensureDataDir(join(tempDir, 'data'));
    seedSession(dataDir);
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  it('redacts secrets from annotation note before DB write', async () => {
    const { handleAnnotate } = await import('../src/commands/annotate.js');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit blocked');
    }) as any);

    try {
      await handleAnnotate({
        dataDir,
        session: 'test-session-1',
        outcome: 'good',
        note: 'Used CANARY_LEAK_TEST_MARKER_ALPHA_ZERO and sk-ABCDEF1234567890ABCDEF123456',
      });
    } catch (e: any) {
      expect(e.message).toBe('process.exit blocked');
    } finally {
      exitSpy.mockRestore();
    }

    // Re-open storage to check DB
    const db2 = new Database(join(dataDir, 'tracker.db'));
    try {
      const row = db2.prepare(
        'SELECT note FROM outcomes WHERE session_id = ?'
      ).get('test-session-1') as { note: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.note).not.toContain('CANARY_LEAK_TEST_MARKER_ALPHA_ZERO');
      expect(row!.note).not.toContain('sk-ABCDEF1234567890ABCDEF123456');
      expect(row!.note).toContain('[REDACTED]');
    } finally {
      db2.close();
    }
  });
});
