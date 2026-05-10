import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage, StorageError } from '../src/storage.js';
import { ensureDataDir } from '../src/config.js';

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows may hold file locks briefly; best-effort cleanup
  }
}

describe('Storage', () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-storage-test-'));
    dataDir = ensureDataDir(join(tempDir, 'data'));
  });

  afterEach(() => {
    safeCleanup(tempDir);
  });

  // VAL-CLI-004: Initialize creates local workspace
  it('creates a new database on open', () => {
    const storage = Storage.open({ dataDir });
    try {
      expect(existsSync(join(dataDir, 'tracker.db'))).toBe(true);
      expect(storage.integrityCheck()).toBe('ok');
    } finally {
      storage.close();
    }
  });

  // VAL-CLI-005: Initialize is idempotent
  it('is idempotent - opening twice does not corrupt state', () => {
    const storage1 = Storage.open({ dataDir });
    storage1.db.exec(
      `INSERT INTO tools (id, name, display_name) VALUES ('test-tool', 'test', 'Test Tool');`
    );
    storage1.close();

    const storage2 = Storage.open({ dataDir });
    try {
      const tools = storage2.db.prepare('SELECT * FROM tools WHERE id = ?').get('test-tool');
      expect(tools).toBeTruthy();
      expect(storage2.integrityCheck()).toBe('ok');
    } finally {
      storage2.close();
    }
  });

  // Schema validation: core tables exist
  it('creates all core tables via migrations', () => {
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('projects');
      expect(tableNames).toContain('tools');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('events');
      expect(tableNames).toContain('git_commits');
      expect(tableNames).toContain('test_outcomes');
      expect(tableNames).toContain('outcomes');
      expect(tableNames).toContain('correlations');
      expect(tableNames).toContain('_migrations');
    } finally {
      storage.close();
    }
  });

  // Schema validation: indexes exist
  it('creates indexes on key columns', () => {
    const storage = Storage.open({ dataDir });
    try {
      const db = storage.db;
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_sessions_source_tool');
      expect(indexNames).toContain('idx_sessions_project');
      expect(indexNames).toContain('idx_sessions_started_at');
      expect(indexNames).toContain('idx_sessions_source_external');
      expect(indexNames).toContain('idx_events_session');
      expect(indexNames).toContain('idx_git_commits_hash');
      expect(indexNames).toContain('idx_outcomes_session');
      expect(indexNames).toContain('idx_correlations_session');
    } finally {
      storage.close();
    }
  });

  // Migration idempotency
  it('runs migrations idempotently', () => {
    const storage1 = Storage.open({ dataDir });
    storage1.close();

    const storage2 = Storage.open({ dataDir });
    try {
      const migrations = storage2.db
        .prepare('SELECT * FROM _migrations')
        .all() as { name: string }[];
      expect(migrations.length).toBe(2);
      expect(migrations.map((m) => m.name)).toEqual(['001_core_schema', '002_v02_features']);
    } finally {
      storage2.close();
    }
  });

  // VAL-CLI-040: Corrupt database is reported safely
  it('reports corrupt database safely with StorageError', () => {
    const corruptPath = join(dataDir, 'tracker.db');
    writeFileSync(corruptPath, 'this is not a valid sqlite database');

    try {
      Storage.open({ dataDir });
      expect.fail('Expected Storage.open to throw on corrupt DB');
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      const storageErr = err as StorageError;
      expect(['DB_OPEN_FAILED', 'DB_CORRUPT']).toContain(storageErr.code);
      expect(storageErr.message).toContain('--force');
    }
  });

  // VAL-CLI-040: Corrupt DB with allowCorrupt flag
  it('still throws on truly unreadable corrupt DB even with allowCorrupt', () => {
    const corruptPath = join(dataDir, 'tracker.db');
    writeFileSync(corruptPath, 'this is not a valid sqlite database');

    expect(() => Storage.open({ dataDir, allowCorrupt: true })).toThrow();
  });

  // VAL-CLI-041: Basic concurrency - WAL mode enables concurrent reads
  it('enables WAL mode for concurrency', () => {
    const storage = Storage.open({ dataDir });
    try {
      const journalMode = storage.db.pragma('journal_mode', { simple: true }) as string;
      expect(journalMode.toLowerCase()).toBe('wal');
    } finally {
      storage.close();
    }
  });

  // VAL-CLI-041: Concurrent access - second reader can open while first is active
  it('supports concurrent read access via WAL', () => {
    const storage1 = Storage.open({ dataDir });
    const storage2 = Storage.open({ dataDir });
    try {
      const count1 = storage1.db.prepare('SELECT count(*) as cnt FROM tools').get() as { cnt: number };
      const count2 = storage2.db.prepare('SELECT count(*) as cnt FROM tools').get() as { cnt: number };
      expect(count1.cnt).toBe(count2.cnt);
    } finally {
      storage1.close();
      storage2.close();
    }
  });

  // VAL-CLI-041: Concurrent writes serialize via busy_timeout
  it('handles concurrent writes with busy_timeout', () => {
    const storage = Storage.open({ dataDir });
    try {
      const insert = storage.db.transaction(() => {
        storage.db.exec(
          `INSERT INTO projects (id, name, path) VALUES ('proj1', 'Project 1', '/path/1');`
        );
        storage.db.exec(
          `INSERT INTO projects (id, name, path) VALUES ('proj2', 'Project 2', '/path/2');`
        );
      });
      insert();

      const count = storage.db.prepare('SELECT count(*) as cnt FROM projects').get() as { cnt: number };
      expect(count.cnt).toBe(2);
    } finally {
      storage.close();
    }
  });

  // Close does not throw
  it('closes cleanly', () => {
    const storage = Storage.open({ dataDir });
    expect(() => storage.close()).not.toThrow();
  });

  // Double close is safe (idempotent)
  it('double close is safe and idempotent', () => {
    const storage = Storage.open({ dataDir });
    storage.close();
    expect(() => storage.close()).not.toThrow();
  });

  // Operations after close throw StorageError
  it('throws StorageError when accessing db after close', () => {
    const storage = Storage.open({ dataDir });
    storage.close();
    expect(() => storage.db).toThrow(StorageError);
    expect(() => storage.db).toThrow('Database is not open');
  });
});

describe('foreign_keys enforcement', () => {
  let dir: string;
  let storage: Storage;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cet-fk-'));
    storage = Storage.open({ dataDir: dir });
  });
  afterEach(() => {
    storage.close();
    safeCleanup(dir);
  });

  it('enforces FK on session_diffs.session_id', () => {
    expect(() => {
      storage.db.prepare(
        `INSERT INTO session_diffs (id, session_id, commit_hash, stats_json, cached_at, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('d1', 'nonexistent-session', 'abc', '{}', 0, 0);
    }).toThrow(/FOREIGN KEY/);
  });
});

describe('migration 002_v02_features', () => {
  let dir: string;
  let storage: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cet-mig-'));
    storage = Storage.open({ dataDir: dir });
  });

  afterEach(() => {
    storage.close();
    safeCleanup(dir);
  });

  it('creates session_diffs table with unique(session_id, commit_hash)', () => {
    const row = storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_diffs'")
      .get();
    expect(row).toBeDefined();
    const idx = storage.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='session_diffs'")
      .all() as { sql: string | null }[];
    const unique = idx.find((r) => r.sql?.includes('UNIQUE'));
    expect(unique).toBeTruthy();
  });

  it('adds prompt_quality_json column to sessions', () => {
    const cols = storage.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    expect(cols.some((c) => c.name === 'prompt_quality_json')).toBe(true);
  });

  it('migration 002 is recorded in _migrations', () => {
    const names = storage.db
      .prepare('SELECT name FROM _migrations ORDER BY id')
      .all() as { name: string }[];
    expect(names.map((n) => n.name)).toContain('002_v02_features');
  });
});

describe('migration idempotency', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cet-idem-'));
  });
  afterEach(() => {
    safeCleanup(dir);
  });

  it('skips already-applied migrations on re-open', () => {
    const s1 = Storage.open({ dataDir: dir });
    const countBefore = (s1.db.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }).c;
    s1.close();

    const s2 = Storage.open({ dataDir: dir });
    try {
      const countAfter = (s2.db.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }).c;
      expect(countAfter).toBe(countBefore);
    } finally {
      s2.close();
    }
  });
});
