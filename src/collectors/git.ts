/**
 * Local Git signal collector.
 *
 * Reads commit metadata from a local Git repository without contacting remotes.
 * Returns structured commit data for correlation with AI coding sessions.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage.js';

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  authoredAt: string;
  branch: string;
  numstat: { insertions: number; deletions: number };
}

/**
 * Collect git commit signals from a local repository directory.
 * Does NOT call any remote — purely local `git log` parsing.
 * Returns empty array if the path is not a git repository.
 */
export function collectGitSignals(repoPath: string): GitCommitInfo[] {
  if (!existsSync(repoPath)) return [];

  const gitDir = join(repoPath, '.git');
  if (!existsSync(gitDir)) return [];

  try {
    const logOutput = execFileSync(
      'git',
      ['log', '--all', '--format=%H|%h|%an|%aI|%D|%s', '--numstat'],
      { cwd: repoPath, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return parseGitLog(logOutput);
  } catch {
    return [];
  }
}

function parseGitLog(output: string): GitCommitInfo[] {
  const lines = output.split('\n').filter((l) => l.trim());
  const commits: GitCommitInfo[] = [];
  let current: GitCommitInfo | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^([0-9a-f]{40})\|([0-9a-f]+)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/);
    if (headerMatch) {
      if (current) commits.push(current);
      const [, hash, shortHash, author, authoredAt, refs, message] = headerMatch;
      let branch = 'HEAD';
      const branchMatch = refs.match(/HEAD\s*->\s*([^,\s]+)/);
      if (branchMatch) {
        branch = branchMatch[1];
      } else if (refs.trim()) {
        const firstRef = refs.split(',')[0].trim();
        if (firstRef) branch = firstRef;
      }

      current = {
        hash,
        shortHash,
        message: message.trim(),
        author: author.trim(),
        authoredAt: authoredAt.trim(),
        branch,
        numstat: { insertions: 0, deletions: 0 },
      };
      continue;
    }

    const numstatMatch = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (numstatMatch && current) {
      const ins = numstatMatch[1] === '-' ? 0 : parseInt(numstatMatch[1], 10);
      const del = numstatMatch[2] === '-' ? 0 : parseInt(numstatMatch[2], 10);
      current.numstat.insertions += ins;
      current.numstat.deletions += del;
    }
  }

  if (current) commits.push(current);
  return commits;
}

/**
 * Store collected git signals into the database.
 * Idempotent — checks for existing hash before inserting to avoid duplicates.
 */
export function storeGitSignals(
  storage: Storage,
  commits: GitCommitInfo[],
  projectId: string,
): number {
  const db = storage.db;
  const existsQuery = db.prepare('SELECT id FROM git_commits WHERE hash = ? AND project_id = ?');
  const insert = db.prepare(`
    INSERT INTO git_commits (id, hash, short_hash, message, author, authored_at, branch, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let stored = 0;
  const insertAll = db.transaction(() => {
    for (const c of commits) {
      const existing = existsQuery.get(c.hash, projectId) as { id: string } | undefined;
      if (existing) continue;

      insert.run(
        randomUUID(),
        c.hash,
        c.shortHash,
        c.message,
        c.author,
        c.authoredAt,
        c.branch,
        projectId,
      );
      stored++;
    }
  });
  insertAll();
  return stored;
}
