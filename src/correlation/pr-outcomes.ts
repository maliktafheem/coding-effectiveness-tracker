import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Storage } from '../storage.js';

export const MAX_HASHES_PER_CALL = 20;

export interface GhRunner {
  available(): Promise<boolean>;
  authed(): Promise<boolean>;
  prList(hashes: string[]): Promise<GhPrRecord[]>;
}

export interface GhPrRecord {
  number: number;
  state: 'MERGED' | 'CLOSED' | 'OPEN';
  title: string;
  url: string;
  mergedAt: string | null;
  closedAt: string | null;
  body: string | null;
  commits: { oid: string }[];
}

export interface PrClassification {
  prNumber: number;
  state: 'merged' | 'closed' | 'open';
  title: string;
  url: string;
  mergedAt: string | null;
  closedAt: string | null;
  reverted: boolean;
}

/**
 * Chunk array of hashes into groups of `size` (default 20).
 */
export function batchHashes(hashes: string[], size = MAX_HASHES_PER_CALL): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < hashes.length; i += size) {
    chunks.push(hashes.slice(i, i + size));
  }
  return chunks;
}

/**
 * Classify single PR from raw GhPrRecord + all fetched PRs.
 * Revert detection: later PR title matches /^Revert/i AND body includes #<thisPrNumber>.
 */
export function classifyPr(pr: GhPrRecord, allPrs: GhPrRecord[]): PrClassification {
  let state: 'merged' | 'closed' | 'open';
  switch (pr.state) {
    case 'MERGED':
      state = 'merged';
      break;
    case 'CLOSED':
      state = 'closed';
      break;
    case 'OPEN':
      state = 'open';
      break;
  }

  let reverted = false;
  if (state === 'merged') {
    for (const other of allPrs) {
      if (other.number === pr.number) continue;
      if (
        /^Revert/i.test(other.title) &&
        other.body &&
        other.body.includes(`#${pr.number}`)
      ) {
        reverted = true;
        break;
      }
    }
  }

  return {
    prNumber: pr.number,
    state,
    title: pr.title,
    url: pr.url,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    reverted,
  };
}

/**
 * Fetch all PRs matching given commit hashes, dedupe by PR number, classify each.
 */
export async function fetchPrOutcomes(
  runner: GhRunner,
  hashes: string[],
): Promise<PrClassification[]> {
  const chunks = batchHashes(hashes);
  const allPrs = new Map<number, GhPrRecord>();

  for (const chunk of chunks) {
    const prs = await runner.prList(chunk);
    for (const pr of prs) {
      allPrs.set(pr.number, pr);
    }
  }

  const uniquePrs = Array.from(allPrs.values());
  return uniquePrs.map(pr => classifyPr(pr, uniquePrs));
}

/**
 * Fetch PR outcomes for commits linked to sessions.
 * Insert/update pr-outcome correlations in storage.
 * Returns count of PRs found and correlations written (new inserts only).
 */
export async function syncPrOutcomes(
  storage: Storage,
  runner: GhRunner,
): Promise<{ prsFound: number; correlationsWritten: number }> {
  if (!(await runner.available())) {
    throw new Error('gh not available');
  }
  if (!(await runner.authed())) {
    throw new Error('gh not authed');
  }

  const db = storage.db;

  // 1. Get distinct commit hashes linked to sessions via git-commit correlations
  const hashRows = db.prepare(
    `SELECT DISTINCT g.hash AS hash FROM correlations c
     JOIN git_commits g ON g.id = c.target_id
     WHERE c.correlation_type = 'git-commit'`,
  ).all() as { hash: string }[];

  if (hashRows.length === 0) {
    return { prsFound: 0, correlationsWritten: 0 };
  }

  const hashes = hashRows.map(r => r.hash);

  // 2. Build commit hash -> session_ids map
  const commitToSessions = new Map<string, string[]>();
  const sessionRows = db.prepare(
    `SELECT g.hash AS hash, c.session_id AS session_id
     FROM correlations c
     JOIN git_commits g ON g.id = c.target_id
     WHERE c.correlation_type = 'git-commit'`,
  ).all() as { hash: string; session_id: string }[];

  for (const row of sessionRows) {
    if (!commitToSessions.has(row.hash)) {
      commitToSessions.set(row.hash, []);
    }
    commitToSessions.get(row.hash)!.push(row.session_id);
  }

  // 3. Fetch all PRs matching these hashes (keep full records for commit matching)
  const chunks = batchHashes(hashes);
  const prMap = new Map<number, GhPrRecord>();

  for (const chunk of chunks) {
    const prs = await runner.prList(chunk);
    for (const pr of prs) {
      prMap.set(pr.number, pr);
    }
  }

  const uniquePrs = Array.from(prMap.values());
  const classifications = uniquePrs.map(pr => classifyPr(pr, uniquePrs));
  const prRecordByNumber = new Map(uniquePrs.map(pr => [pr.number, pr]));

  // 4. Insert/update correlations
  let correlationsWritten = 0;

  const insertStmt = db.prepare(
    `INSERT INTO correlations (id, session_id, correlation_type, target_id, confidence, metadata_json)
     VALUES (?, ?, 'pr-outcome', ?, 1, ?)`,
  );

  const checkStmt = db.prepare(
    `SELECT id, metadata_json FROM correlations
     WHERE session_id = ? AND correlation_type = 'pr-outcome' AND target_id = ?`,
  );

  const updateStmt = db.prepare(
    `UPDATE correlations SET metadata_json = ? WHERE id = ?`,
  );

  const operation = db.transaction(() => {
    for (const cls of classifications) {
      const record = prRecordByNumber.get(cls.prNumber);
      if (!record) continue;

      // Find sessions whose git-commit correlations match this PR's commits
      const matchedSessionIds = new Set<string>();
      for (const commit of record.commits) {
        const sessions = commitToSessions.get(commit.oid);
        if (sessions) {
          for (const sid of sessions) {
            matchedSessionIds.add(sid);
          }
        }
      }

      if (matchedSessionIds.size === 0) continue;

      // Store only pr-state fields, not entire PR record
      const metadata = {
        prNumber: cls.prNumber,
        state: cls.state,
        title: cls.title,
        url: cls.url,
        mergedAt: cls.mergedAt,
        closedAt: cls.closedAt,
        reverted: cls.reverted,
      };
      const metadataJson = JSON.stringify(metadata);

      for (const sessionId of matchedSessionIds) {
        const existing = checkStmt.get(
          sessionId,
          String(cls.prNumber),
        ) as { id: string; metadata_json: string } | undefined;

        if (existing) {
          const existingMeta = JSON.parse(existing.metadata_json) as { state: string };
          if (existingMeta.state !== cls.state) {
            updateStmt.run(metadataJson, existing.id);
          }
          // Unchanged state: skip (no update, no count)
        } else {
          insertStmt.run(
            randomUUID(),
            sessionId,
            String(cls.prNumber),
            metadataJson,
          );
          correlationsWritten++;
        }
      }
    }
  });

  operation();

  return {
    prsFound: classifications.length,
    correlationsWritten,
  };
}

/**
 * Default production runner using `gh` CLI via execFileSync.
 * Spawns `gh pr list` with search query. Retries on rate-limit (429) with
 * exponential backoff [5s, 15s, 45s, 120s]. Max 4 retries, then throws.
 */
export class DefaultGhRunner implements GhRunner {
  async available(): Promise<boolean> {
    try {
      execFileSync('gh', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async authed(): Promise<boolean> {
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async prList(hashes: string[]): Promise<GhPrRecord[]> {
    const delays = [5000, 15000, 45000, 120000];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const stdout = execFileSync('gh', [
          'pr', 'list',
          '--search', hashes.join(' '),
          '--state', 'all',
          '--json', 'number,state,title,url,mergedAt,closedAt,body,commits',
        ], { encoding: 'utf-8' });
        return JSON.parse(stdout) as GhPrRecord[];
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const stderr = (err as { stderr?: string }).stderr ?? '';
        const isRateLimit = stderr.includes('429') || stderr.includes('rate limit');

        if (!isRateLimit || attempt === delays.length) {
          throw lastError;
        }

        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }

    throw lastError ?? new Error('prList failed');
  }
}
