import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../src/storage.js';
import {
  batchHashes,
  classifyPr,
  fetchPrOutcomes,
  syncPrOutcomes,
  type GhRunner,
  type GhPrRecord,
} from '../src/correlation/pr-outcomes.js';

function stubRunner(prs: GhPrRecord[] = []): GhRunner {
  return {
    available: async () => true,
    authed: async () => true,
    prList: async () => prs,
  };
}

describe('batchHashes', () => {
  it('returns single chunk for small array', () => {
    expect(batchHashes(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']]);
  });
  it('chunks at 20 by default', () => {
    const hashes = Array.from({ length: 45 }, (_, i) => `h${i}`);
    const chunks = batchHashes(hashes);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(20);
    expect(chunks[1].length).toBe(20);
    expect(chunks[2].length).toBe(5);
  });
  it('empty array returns empty', () => {
    expect(batchHashes([])).toEqual([]);
  });
});

describe('classifyPr', () => {
  it('merged non-reverted', () => {
    const pr: GhPrRecord = { number: 10, state: 'MERGED', title: 'Add feature', url: 'x', mergedAt: 't', closedAt: null, body: null, commits: [{ oid: 'abc' }] };
    expect(classifyPr(pr, [pr]).reverted).toBe(false);
    expect(classifyPr(pr, [pr]).state).toBe('merged');
  });

  it('merged with later Revert PR referencing #10 is reverted', () => {
    const orig: GhPrRecord = { number: 10, state: 'MERGED', title: 'Add feature', url: 'x', mergedAt: 't', closedAt: null, body: null, commits: [{ oid: 'abc' }] };
    const revert: GhPrRecord = { number: 11, state: 'MERGED', title: 'Revert "Add feature"', url: 'y', mergedAt: 't2', closedAt: null, body: 'This reverts #10', commits: [{ oid: 'def' }] };
    expect(classifyPr(orig, [orig, revert]).reverted).toBe(true);
  });

  it('closed unmerged is abandoned', () => {
    const pr: GhPrRecord = { number: 10, state: 'CLOSED', title: 'X', url: 'x', mergedAt: null, closedAt: 't', body: null, commits: [] };
    expect(classifyPr(pr, [pr]).state).toBe('closed');
  });

  it('open is in-flight', () => {
    const pr: GhPrRecord = { number: 10, state: 'OPEN', title: 'X', url: 'x', mergedAt: null, closedAt: null, body: null, commits: [] };
    expect(classifyPr(pr, [pr]).state).toBe('open');
  });

  it('revert title alone without body reference does NOT mark reverted', () => {
    const orig: GhPrRecord = { number: 10, state: 'MERGED', title: 'Add X', url: 'x', mergedAt: 't', closedAt: null, body: null, commits: [] };
    const revertOther: GhPrRecord = { number: 11, state: 'MERGED', title: 'Revert "Add Y"', url: 'y', mergedAt: 't', closedAt: null, body: 'This reverts #99', commits: [] };
    expect(classifyPr(orig, [orig, revertOther]).reverted).toBe(false);
  });
});

describe('fetchPrOutcomes', () => {
  it('batches hashes in chunks of 20', async () => {
    const hashes = Array.from({ length: 45 }, (_, i) => `h${i}`);
    let calls = 0;
    const runner: GhRunner = {
      available: async () => true,
      authed: async () => true,
      prList: async () => { calls++; return []; },
    };
    await fetchPrOutcomes(runner, hashes);
    expect(calls).toBe(3);
  });

  it('dedupes PRs across batches', async () => {
    const pr: GhPrRecord = { number: 10, state: 'MERGED', title: 'X', url: 'x', mergedAt: 't', closedAt: null, body: null, commits: [{ oid: 'abc' }] };
    let call = 0;
    const runner: GhRunner = {
      available: async () => true,
      authed: async () => true,
      prList: async () => {
        call++;
        return [pr]; // same PR returned in every batch
      },
    };
    const hashes = Array.from({ length: 25 }, (_, i) => `h${i}`);
    const results = await fetchPrOutcomes(runner, hashes);
    expect(call).toBe(2);
    expect(results.length).toBe(1);
    expect(results[0].prNumber).toBe(10);
  });
});

describe('syncPrOutcomes', () => {
  let dir: string;
  let storage: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cet-pr-'));
    storage = Storage.open({ dataDir: dir });
  });

  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  function seedSessionWithCommit(sessionId: string, commitHash: string): void {
    storage.db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('t', 't', 'T');
    storage.db.prepare('INSERT INTO sessions (id, source_tool_id) VALUES (?, ?)').run(sessionId, 't');
    const commitId = randomUUID();
    storage.db.prepare('INSERT INTO git_commits (id, hash, short_hash) VALUES (?, ?, ?)')
      .run(commitId, commitHash, commitHash.slice(0, 7));
    storage.db.prepare(
      "INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json) VALUES (?, ?, 'git-commit', ?, 1, '{}')",
    ).run(randomUUID(), sessionId, commitId);
  }

  it('writes pr-outcome correlation for matching commit', async () => {
    seedSessionWithCommit('s1', 'abc123');
    const pr: GhPrRecord = {
      number: 42, state: 'MERGED', title: 'X', url: 'u', mergedAt: 't', closedAt: null, body: null,
      commits: [{ oid: 'abc123' }],
    };
    const summary = await syncPrOutcomes(storage, stubRunner([pr]));
    expect(summary.prsFound).toBe(1);
    expect(summary.correlationsWritten).toBe(1);

    const rows = storage.db.prepare("SELECT * FROM correlations WHERE correlation_type = 'pr-outcome'").all() as { target_id: string; metadata_json: string; session_id: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('s1');
    expect(rows[0].target_id).toBe('42');
    const meta = JSON.parse(rows[0].metadata_json);
    expect(meta.state).toBe('merged');
    expect(meta.reverted).toBe(false);
  });

  it('no session with matching commit -> no correlations', async () => {
    seedSessionWithCommit('s1', 'different-hash');
    const pr: GhPrRecord = {
      number: 42, state: 'MERGED', title: 'X', url: 'u', mergedAt: 't', closedAt: null, body: null,
      commits: [{ oid: 'abc123' }],
    };
    const summary = await syncPrOutcomes(storage, stubRunner([pr]));
    expect(summary.correlationsWritten).toBe(0);
  });

  it('does not duplicate correlation on re-run with unchanged state', async () => {
    seedSessionWithCommit('s1', 'abc123');
    const pr: GhPrRecord = {
      number: 42, state: 'MERGED', title: 'X', url: 'u', mergedAt: 't', closedAt: null, body: null,
      commits: [{ oid: 'abc123' }],
    };
    await syncPrOutcomes(storage, stubRunner([pr]));
    await syncPrOutcomes(storage, stubRunner([pr]));
    const count = (storage.db.prepare("SELECT COUNT(*) as c FROM correlations WHERE correlation_type = 'pr-outcome'").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('updates existing correlation when reverted flips even if state unchanged', async () => {
    seedSessionWithCommit('s1', 'abc123');

    // Seed existing correlation: merged, not reverted
    storage.db.prepare(
      `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
       VALUES (?, ?, 'pr-outcome', ?, 1, ?)`,
    ).run('pr-seed-4', 's1', '42', JSON.stringify({
      prNumber: 42, state: 'merged', title: 'Original', url: 'u', mergedAt: 't', closedAt: null, reverted: false,
    }));

    // Fixture: original PR still merged AND a Revert PR targeting #42
    const orig: GhPrRecord = {
      number: 42, state: 'MERGED', title: 'Original', url: 'u', mergedAt: 't', closedAt: null, body: null,
      commits: [{ oid: 'abc123' }],
    };
    const revert: GhPrRecord = {
      number: 99, state: 'MERGED', title: 'Revert "Original"', url: 'r', mergedAt: 't2', closedAt: null,
      body: 'This reverts commit. Fixes #42', commits: [{ oid: 'def456' }],
    };
    await syncPrOutcomes(storage, stubRunner([orig, revert]));

    const rows = storage.db.prepare("SELECT metadata_json FROM correlations WHERE correlation_type = 'pr-outcome' AND target_id = '42'").all() as { metadata_json: string }[];
    expect(rows.length).toBe(1);
    const meta = JSON.parse(rows[0].metadata_json);
    expect(meta.reverted).toBe(true);
  });

  it('updates existing correlation when state changes', async () => {
    seedSessionWithCommit('s1', 'abc123');
    const open: GhPrRecord = {
      number: 42, state: 'OPEN', title: 'X', url: 'u', mergedAt: null, closedAt: null, body: null,
      commits: [{ oid: 'abc123' }],
    };
    const merged: GhPrRecord = { ...open, state: 'MERGED', mergedAt: 't' };
    await syncPrOutcomes(storage, stubRunner([open]));
    await syncPrOutcomes(storage, stubRunner([merged]));
    const rows = storage.db.prepare("SELECT metadata_json FROM correlations WHERE correlation_type = 'pr-outcome'").all() as { metadata_json: string }[];
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].metadata_json).state).toBe('merged');
  });

  it('throws when gh not available', async () => {
    seedSessionWithCommit('s1', 'abc');
    const runner: GhRunner = {
      available: async () => false,
      authed: async () => true,
      prList: async () => [],
    };
    await expect(syncPrOutcomes(storage, runner)).rejects.toThrow(/gh.*not/i);
  });

  it('throws when gh not authed', async () => {
    seedSessionWithCommit('s1', 'abc');
    const runner: GhRunner = {
      available: async () => true,
      authed: async () => false,
      prList: async () => [],
    };
    await expect(syncPrOutcomes(storage, runner)).rejects.toThrow(/auth/i);
  });
});
