import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Storage } from '../src/storage.js';
import { deriveShipStatus, type ShipStatus } from '../src/correlation/ship-status.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function seedSession(storage: Storage, id: string, hasCommit = false): void {
  storage.db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t1', 't1', 'T1');
  storage.db.prepare('INSERT INTO sessions (id, source_tool_id) VALUES (?, ?)').run(id, 't1');
  if (hasCommit) {
    const commitRowId = randomUUID();
    storage.db.prepare(
      `INSERT INTO git_commits (id, hash, short_hash, message) VALUES (?, ?, ?, ?)`,
    ).run(commitRowId, `hash-${id}`, `h${id}`, 'msg');
    storage.db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'git-commit', ?, 1, '{}')`,
    ).run(randomUUID(), id, commitRowId);
  }
}

function seedPR(
  storage: Storage,
  sessionId: string,
  state: 'merged' | 'closed' | 'open',
  reverted = false,
  prNumber = 42,
): void {
  storage.db.prepare(
    `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
     VALUES (?, ?, 'pr-outcome', ?, 1, ?)`,
  ).run(randomUUID(), sessionId, String(prNumber), JSON.stringify({ state, reverted, prNumber }));
}

describe('deriveShipStatus', () => {
  let dir: string;
  let storage: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cet-ship-'));
    storage = Storage.open({ dataDir: dir });
  });
  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty map for empty input', () => {
    expect(deriveShipStatus(storage.db, []).size).toBe(0);
  });

  it('returns "unlinked" when no commit correlations exist', () => {
    seedSession(storage, 's1');
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('unlinked');
  });

  it('returns null when commits exist but no PR correlation', () => {
    seedSession(storage, 's1', true);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBeNull();
  });

  it('returns "shipped" for merged non-reverted PR', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'merged', false);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('shipped');
  });

  it('returns "reverted" for merged reverted PR', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'merged', true);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('reverted');
  });

  it('"reverted" has priority over "shipped" when multiple PRs', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'merged', false, 1);
    seedPR(storage, 's1', 'merged', true, 2);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('reverted');
  });

  it('returns "abandoned" for closed unmerged PR', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'closed', false);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('abandoned');
  });

  it('returns "in-flight" for open PR', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'open', false);
    expect(deriveShipStatus(storage.db, ['s1']).get('s1')).toBe<ShipStatus>('in-flight');
  });

  it('handles multiple sessions in one call', () => {
    seedSession(storage, 's1', true);
    seedPR(storage, 's1', 'merged', false);
    seedSession(storage, 's2', true);
    seedPR(storage, 's2', 'closed', false);
    seedSession(storage, 's3');
    const result = deriveShipStatus(storage.db, ['s1', 's2', 's3']);
    expect(result.get('s1')).toBe<ShipStatus>('shipped');
    expect(result.get('s2')).toBe<ShipStatus>('abandoned');
    expect(result.get('s3')).toBe<ShipStatus>('unlinked');
  });

  it('sessions with no rows still appear as "unlinked"', () => {
    const result = deriveShipStatus(storage.db, ['missing-session-id']);
    expect(result.get('missing-session-id')).toBe<ShipStatus>('unlinked');
  });

  it('batches N sessions in ≤2 queries (no N+1)', () => {
    for (let i = 0; i < 50; i++) seedSession(storage, `s${i}`, true);
    let prepareCalls = 0;
    const origPrepare = storage.db.prepare.bind(storage.db);
    (storage.db as { prepare: typeof storage.db.prepare }).prepare = ((sql: string) => {
      prepareCalls++;
      return origPrepare(sql);
    }) as typeof storage.db.prepare;
    const ids = Array.from({ length: 50 }, (_, i) => `s${i}`);
    deriveShipStatus(storage.db, ids);
    expect(prepareCalls).toBeLessThanOrEqual(2);
  });
});