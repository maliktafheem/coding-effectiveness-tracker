/**
 * CLI diff command handler.
 * Shows git diff of commits linked to a session.
 */

import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage } from '../storage.js';
import { getSessionDiffs, type SessionCommitDiff } from '../analytics/diff-service.js';

interface DiffOptions {
  dataDir?: string;
  repo?: string;
  commit?: string;
  stats?: boolean;
  files?: boolean;
  cache?: boolean;
}

export async function handleDiff(sessionId: string, opts: DiffOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  ensureInitialized(dataDir);
  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });

    const session = storage.db
      .prepare('SELECT id, metadata_json FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; metadata_json: string | null } | undefined;

    if (!session) {
      process.stderr.write(`Session not found: ${sessionId}\n`);
      process.exitCode = 1;
      return;
    }

    const repoPath = opts.repo ?? parseRepoPath(session.metadata_json);
    if (!repoPath) {
      process.stderr.write(
        'Repo path required: pass --repo <path> or ensure session metadata contains projectPath.\n',
      );
      process.exitCode = 1;
      return;
    }

    const diffs = getSessionDiffs(storage.db, sessionId, {
      repoPath,
      refresh: opts.cache === false,
    });

    const filtered = opts.commit
      ? diffs.filter(
          (d) => d.hash.startsWith(opts.commit!) || d.shortHash.startsWith(opts.commit!),
        )
      : diffs;

    if (filtered.length === 0) {
      process.stdout.write('No commits linked to this session.\n');
      return;
    }

    for (const d of filtered) {
      if (opts.stats) {
        renderStats(d);
        continue;
      }
      if (opts.files) {
        renderFiles(d);
        continue;
      }
      renderFull(d);
    }
  } finally {
    storage?.close();
  }
}

function renderStats(d: SessionCommitDiff): void {
  const filesLabel = d.stats.files === 1 ? '1 file' : `${d.stats.files} files`;
  const skip = d.skipped ? ` [${d.skipped}]` : '';
  process.stdout.write(
    `${d.shortHash} ${filesLabel}, +${d.stats.insertions}/-${d.stats.deletions}${skip}\n`,
  );
}

function renderFiles(d: SessionCommitDiff): void {
  process.stdout.write(`${d.shortHash} ${d.message ?? ''}\n`);
  if (d.skipped) {
    process.stdout.write(`  (${d.skipped})\n`);
    return;
  }
  if (d.diff) {
    for (const f of extractFiles(d.diff)) {
      process.stdout.write(`  ${f}\n`);
    }
  }
}

function renderFull(d: SessionCommitDiff): void {
  process.stdout.write(`${d.shortHash} ${d.message ?? ''}\n`);
  if (d.skipped) {
    process.stdout.write(
      `  skipped (${d.skipped}) ${d.stats.files} files, +${d.stats.insertions}/-${d.stats.deletions}\n`,
    );
    return;
  }
  if (d.diff) process.stdout.write(`${d.diff}\n`);
}

function parseRepoPath(metadataJson: string | null): string | undefined {
  if (!metadataJson) return undefined;
  try {
    const parsed = JSON.parse(metadataJson) as { projectPath?: string };
    return parsed.projectPath;
  } catch {
    return undefined;
  }
}

function extractFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) files.add(m[1]);
  }
  return Array.from(files);
}
