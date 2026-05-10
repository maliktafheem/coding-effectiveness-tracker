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
import { join, resolve, isAbsolute } from 'node:path';
import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { collectGitSignals, storeGitSignals } from '../collectors/git.js';
import { correlateSession } from '../correlation/engine.js';
import { deriveProjectId, deriveProjectName } from '../project-identity.js';
import {
  DefaultGhRunner,
  FixtureGhRunner,
  syncPrOutcomes,
  type GhRunner,
} from '../correlation/pr-outcomes.js';

interface SyncOptions {
  dataDir?: string;
  repo: string;
  project?: string;
  pr?: boolean;
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
      projectId = deriveProjectId(repoPath);
    }

    // Ensure project exists
    const existingProject = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
    if (!existingProject) {
      db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(
        projectId,
        deriveProjectName(repoPath),
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

    if (opts.pr) {
      console.log('\nFetching PR outcomes from GitHub...');
      try {
        const fixturePath = process.env.CET_TEST_GH_FIXTURE;
        const runner: GhRunner = fixturePath
          ? new FixtureGhRunner(fixturePath)
          : new DefaultGhRunner();
        const prSummary = await syncPrOutcomes(storage, runner);
        console.log(
          `Found ${prSummary.prsFound} PR(s), wrote ${prSummary.correlationsWritten} new pr-outcome correlation(s).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('gh not available')) {
          console.error('Error: `gh` CLI not installed. Install from https://cli.github.com/ to use --pr.');
        } else if (msg.includes('gh not authed')) {
          console.error('Error: `gh` CLI not authenticated. Run `gh auth login`.');
        } else {
          console.error('Error fetching PR outcomes: ' + msg);
        }
        process.exitCode = 1;
      }
    }
  } finally {
    storage?.close();
  }
}
