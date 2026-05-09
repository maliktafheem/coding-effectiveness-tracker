/**
 * CLI sync command handler.
 *
 * Collects git commit signals from a local repository and stores them
 * in the database. Then correlates stored commits with existing imported
 * AI coding sessions using time-overlap confidence scoring.
 *
 * Privacy-safe: reads only from the local git repository; no remote
 * git fetch/push/API calls are made.
 *
 * Idempotent: re-running against the same repo does not duplicate commits.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, basename } from 'node:path';
import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { collectGitSignals, storeGitSignals } from '../collectors/git.js';
import { correlateSession } from '../correlation/engine.js';

interface SyncOptions {
  dataDir?: string;
  repo: string;
  project?: string;
}

export async function handleSync(opts: SyncOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  ensureInitialized(dataDir);

  // Resolve repo path
  const repoPath = isAbsolute(opts.repo) ? opts.repo : resolve(opts.repo);

  if (!existsSync(repoPath)) {
    console.error('Error: Repository path not found: ' + repoPath);
    process.exit(1);
  }

  const st = statSync(repoPath);
  if (!st.isDirectory()) {
    console.error('Error: Repository path is not a directory: ' + repoPath);
    process.exit(1);
  }

  // Verify it's a git repo (has .git directory)
  if (!existsSync(join(repoPath, '.git'))) {
    console.error('Error: Not a git repository (no .git directory): ' + repoPath);
    console.error('Sync requires a local git repository path.');
    process.exit(1);
  }

  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });
  } catch (err) {
    if (err instanceof StorageError) {
      console.error('Error: ' + err.message);
      process.exit(1);
    }
    throw err;
  }

  try {
    const db = storage.db;

    // Determine or create project ID
    let projectId = opts.project;
    if (!projectId) {
      // Auto-derive project ID from repo directory name
      projectId = basename(repoPath).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }

    // Ensure project exists
    const existingProject = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
    if (!existingProject) {
      db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(
        projectId,
        basename(repoPath),
        repoPath,
      );
      console.log('Created project: ' + projectId);
    }

    // Collect git signals (local-only — no remote calls)
    const commits = collectGitSignals(repoPath);

    if (commits.length === 0) {
      console.log('No commits found in repository: ' + repoPath);
      console.log('The repository may be empty or the git command failed.');
      return;
    }

    // Store commits (idempotent — skips existing hashes)
    const stored = storeGitSignals(storage, commits, projectId);

    // Correlate commits with existing sessions
    const sessions = db.prepare(
      'SELECT id FROM sessions WHERE project_id = ?'
    ).all(projectId) as { id: string }[];

    let correlationCount = 0;
    for (const session of sessions) {
      const correlations = correlateSession(storage, session.id);
      correlationCount += correlations.length;
    }

    // Output summary
    console.log('Git sync complete for ' + repoPath);
    console.log('  Project: ' + projectId);
    console.log('  Commits found: ' + commits.length);
    console.log('  New commits stored: ' + stored);
    console.log('  Existing commits (skipped): ' + (commits.length - stored));
    console.log('  Sessions correlated: ' + sessions.length);
    console.log('  Correlations created: ' + correlationCount);
    console.log('');
    console.log('Privacy: All data stays local. No remote git calls were made.');
  } finally {
    storage?.close();
  }
}
