import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const DIFF_SIZE_CAP_BYTES = 100 * 1024;

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface SessionCommitDiff {
  hash: string;
  shortHash: string;
  message: string | null;
  stats: DiffStats;
  diff?: string;
  skipped?: 'too-large' | 'repo-missing';
}

export interface GetDiffsOptions {
  repoPath: string;
  refresh?: boolean;
}

interface CommitRow {
  hash: string;
  short_hash: string;
  message: string | null;
}

interface CacheRow {
  diff_text: string | null;
  stats_json: string;
  skipped_reason: string | null;
  cached_at: number;
}

export function getSessionDiffs(
  db: Database.Database,
  sessionId: string,
  opts: GetDiffsOptions,
): SessionCommitDiff[] {
  const commits = db
    .prepare(
      `SELECT g.hash, g.short_hash, g.message
       FROM correlations c
       JOIN git_commits g ON g.id = c.target_id
       WHERE c.session_id = ? AND c.correlation_type = 'git-commit'
       ORDER BY g.authored_at`,
    )
    .all(sessionId) as CommitRow[];

  const repoExists = existsSync(opts.repoPath);
  const result: SessionCommitDiff[] = [];

  for (const c of commits) {
    const cached =
      opts.refresh
        ? undefined
        : (db
            .prepare(
              'SELECT diff_text, stats_json, skipped_reason, cached_at FROM session_diffs WHERE session_id = ? AND commit_hash = ?',
            )
            .get(sessionId, c.hash) as CacheRow | undefined);

    if (cached) {
      result.push(fromCache(c, cached));
      continue;
    }

    if (!repoExists) {
      upsert(db, sessionId, c.hash, null, { files: 0, insertions: 0, deletions: 0 }, 'repo-missing');
      result.push({
        hash: c.hash,
        shortHash: c.short_hash,
        message: c.message,
        stats: { files: 0, insertions: 0, deletions: 0 },
        skipped: 'repo-missing',
      });
      continue;
    }

    const stats = getStats(opts.repoPath, c.hash);
    const raw = getDiffText(opts.repoPath, c.hash);
    const size = Buffer.byteLength(raw, 'utf-8');

    if (size > DIFF_SIZE_CAP_BYTES) {
      upsert(db, sessionId, c.hash, null, stats, 'too-large');
      result.push({
        hash: c.hash,
        shortHash: c.short_hash,
        message: c.message,
        stats,
        skipped: 'too-large',
      });
    } else {
      upsert(db, sessionId, c.hash, raw, stats, null);
      result.push({
        hash: c.hash,
        shortHash: c.short_hash,
        message: c.message,
        stats,
        diff: raw,
      });
    }
  }

  return result;
}

function fromCache(c: CommitRow, row: CacheRow): SessionCommitDiff {
  const stats = JSON.parse(row.stats_json) as DiffStats;
  const base: SessionCommitDiff = {
    hash: c.hash,
    shortHash: c.short_hash,
    message: c.message,
    stats,
  };
  if (row.skipped_reason === 'too-large') return { ...base, skipped: 'too-large' };
  if (row.skipped_reason === 'repo-missing') return { ...base, skipped: 'repo-missing' };
  return { ...base, diff: row.diff_text ?? '' };
}

function getStats(repoPath: string, hash: string): DiffStats {
  const out = execFileSync('git', ['show', '--numstat', '--format=', hash], {
    cwd: repoPath,
    encoding: 'utf-8',
  });
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files++;
    const ins = parseInt(parts[0], 10);
    const del = parseInt(parts[1], 10);
    if (!Number.isNaN(ins)) insertions += ins;
    if (!Number.isNaN(del)) deletions += del;
  }
  return { files, insertions, deletions };
}

function getDiffText(repoPath: string, hash: string): string {
  return execFileSync('git', ['show', '--format=', hash], {
    cwd: repoPath,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function upsert(
  db: Database.Database,
  sessionId: string,
  hash: string,
  diffText: string | null,
  stats: DiffStats,
  skipped: string | null,
): void {
  const now = Date.now();
  const size = diffText ? Buffer.byteLength(diffText, 'utf-8') : 0;
  db.prepare(
    `INSERT INTO session_diffs (id, session_id, commit_hash, diff_text, stats_json, cached_at, size_bytes, skipped_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, commit_hash) DO UPDATE SET
       diff_text = excluded.diff_text,
       stats_json = excluded.stats_json,
       cached_at = excluded.cached_at,
       size_bytes = excluded.size_bytes,
       skipped_reason = excluded.skipped_reason`,
  ).run(randomUUID(), sessionId, hash, diffText, JSON.stringify(stats), now, size, skipped);
}
