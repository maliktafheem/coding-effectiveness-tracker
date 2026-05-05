import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

export interface StorageOptions {
  dataDir: string;
  /** Allow opening a potentially corrupt DB (for error reporting). */
  allowCorrupt?: boolean;
}

export class Storage {
  private _db: Database.Database | null;
  private _dbPath: string;

  private constructor(db: Database.Database, dbPath: string) {
    this._db = db;
    this._dbPath = dbPath;
  }

  /**
   * Open or create the SQLite database in the given data directory.
   * Runs pending migrations.
   */
  static open(opts: StorageOptions): Storage {
    const dbPath = join(opts.dataDir, 'tracker.db');
    const dbExists = existsSync(dbPath);

    let db: Database.Database;
    try {
      db = new Database(dbPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new StorageError(
        `Failed to open database at ${dbPath}: ${message}`,
        'DB_OPEN_FAILED',
      );
    }

    // Wrap pragma and integrity check — a corrupt file may open successfully
    // but fail on the first pragma or integrity check.
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
    } catch (err) {
      try { db.close(); } catch { /* ignore */ }
      const message = err instanceof Error ? err.message : String(err);
      throw new StorageError(
        `Failed to configure database at ${dbPath}: ${message}. ` +
        `Run 'cet init --force' to reinitialize.`,
        'DB_CORRUPT',
      );
    }

    // Run integrity check on existing databases
    if (dbExists && !opts.allowCorrupt) {
      try {
        const result = db.pragma('integrity_check', { simple: true }) as string;
        if (result !== 'ok') {
          try { db.close(); } catch { /* ignore */ }
          throw new StorageError(
            `Database integrity check failed at ${dbPath}. ` +
            `Result: ${result}. Back up the file and run 'cet init --force' to reinitialize.`,
            'DB_CORRUPT',
          );
        }
      } catch (err) {
        if (err instanceof StorageError) throw err;
        try { db.close(); } catch { /* ignore */ }
        const message = err instanceof Error ? err.message : String(err);
        throw new StorageError(
          `Database integrity check failed at ${dbPath}: ${message}. ` +
          `Back up the file and run 'cet init --force' to reinitialize.`,
          'DB_CORRUPT',
        );
      }
    }

    const storage = new Storage(db, dbPath);
    storage.runMigrations();
    return storage;
  }

  /** Run all pending migrations in order. */
  private runMigrations(): void {
    const db = this.db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const applied = new Set(
      (db.prepare('SELECT name FROM _migrations').all() as { name: string }[])
        .map((r) => r.name),
    );

    const migrations = getMigrations();
    for (const migration of migrations) {
      if (!applied.has(migration.name)) {
        const run = db.transaction(() => {
          db.exec(migration.sql);
          db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name);
        });
        run();
      }
    }
  }

  /** Get the underlying better-sqlite3 database instance. */
  get db(): Database.Database {
    if (!this._db) throw new StorageError('Database is not open', 'DB_NOT_OPEN');
    return this._db;
  }

  /** Get the path to the database file. */
  get dbPath(): string {
    return this._dbPath;
  }

  /** Close the database connection. Safe to call multiple times. */
  close(): void {
    if (this._db) {
      try {
        this._db.close();
      } catch {
        // Already closed or corrupt — safe to ignore
      }
      this._db = null;
    }
  }

  /** Run a PRAGMA integrity_check. Returns 'ok' if healthy. */
  integrityCheck(): string {
    return this.db.pragma('integrity_check', { simple: true }) as string;
  }
}

export class StorageError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

interface Migration {
  name: string;
  sql: string;
}

function getMigrations(): Migration[] {
  return [
    {
      name: '001_core_schema',
      sql: `
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tools (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          source_tool_id TEXT NOT NULL,
          project_id TEXT,
          external_id TEXT,
          started_at TEXT,
          ended_at TEXT,
          duration_ms INTEGER,
          summary TEXT,
          model TEXT,
          tokens_input INTEGER,
          tokens_output INTEGER,
          cost_estimate REAL,
          metadata_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (source_tool_id) REFERENCES tools(id),
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_source_tool ON sessions(source_tool_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_source_external
          ON sessions(source_tool_id, external_id) WHERE external_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          occurred_at TEXT,
          summary TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

        CREATE TABLE IF NOT EXISTS git_commits (
          id TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          short_hash TEXT NOT NULL,
          message TEXT,
          author TEXT,
          authored_at TEXT,
          branch TEXT,
          project_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );

        CREATE INDEX IF NOT EXISTS idx_git_commits_hash ON git_commits(hash);
        CREATE INDEX IF NOT EXISTS idx_git_commits_project ON git_commits(project_id);

        CREATE TABLE IF NOT EXISTS session_commits (
          session_id TEXT NOT NULL,
          commit_id TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (session_id, commit_id),
          FOREIGN KEY (session_id) REFERENCES sessions(id),
          FOREIGN KEY (commit_id) REFERENCES git_commits(id)
        );

        CREATE TABLE IF NOT EXISTS test_outcomes (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          session_id TEXT,
          commit_id TEXT,
          command TEXT,
          passed INTEGER,
          failed INTEGER,
          skipped INTEGER,
          duration_ms INTEGER,
          raw_output_summary TEXT,
          run_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (session_id) REFERENCES sessions(id),
          FOREIGN KEY (commit_id) REFERENCES git_commits(id)
        );

        CREATE INDEX IF NOT EXISTS idx_test_outcomes_session ON test_outcomes(session_id);
        CREATE INDEX IF NOT EXISTS idx_test_outcomes_commit ON test_outcomes(commit_id);

        CREATE TABLE IF NOT EXISTS outcomes (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          outcome_type TEXT NOT NULL,
          score REAL,
          label TEXT,
          note TEXT,
          tags_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_outcomes_session ON outcomes(session_id);
        CREATE INDEX IF NOT EXISTS idx_outcomes_type ON outcomes(outcome_type);

        CREATE TABLE IF NOT EXISTS correlations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          correlation_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.0,
          metadata_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_correlations_session ON correlations(session_id);
        CREATE INDEX IF NOT EXISTS idx_correlations_type ON correlations(correlation_type);
      `,
    },
  ];
}

/** Find all migration SQL files in the migrations directory. */
export function findMigrationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}
