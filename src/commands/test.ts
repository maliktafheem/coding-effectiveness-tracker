/**
 * CLI test command handler.
 *
 * Runs a user-specified command, streams its output to the terminal,
 * and records the outcome (exit code, timing, command string) in the
 * database for correlation with AI coding sessions.
 *
 * Usage: cet test -- <command>
 * Examples:
 *   cet test -- npm test
 *   cet test -- node -e "process.exit(0)"
 *   cet test -- pytest tests/
 */

import { spawn } from 'node:child_process';
import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { collectTestOutcomes, type TestOutcomeRecord } from '../collectors/test-outcomes.js';
import { correlateSession } from '../correlation/engine.js';
import { deriveProjectId } from '../project-identity.js';
import { redactSecrets } from '../importers/privacy.js';

interface TestOptions {
  dataDir?: string;
  project?: string;
  /** The command and args after -- */
  args: string[];
}

export async function handleTest(opts: TestOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  ensureInitialized(dataDir);

  if (opts.args.length === 0) {
    console.error('Error: No command provided after --.');
    console.error('Usage: cet test -- <command>');
    console.error('Example: cet test -- npm test');
    process.exit(1);
  }

  const commandStr = opts.args.join(' ');
  const [executable, ...execArgs] = opts.args;
  const cwd = process.cwd();
  const startTime = new Date();

  // Stream subprocess output to terminal and capture for storage
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const child = spawn(executable, execArgs, {
    cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    process.stdout.write(text);
    stdoutChunks.push(text);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    process.stderr.write(text);
    stderrChunks.push(text);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error('Failed to start command: ' + err.message);
      resolve(1);
    });
  });

  const endTime = new Date();
  const durationMs = endTime.getTime() - startTime.getTime();

  // Record outcome in database
  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });

    const db = storage.db;
    const projectId = opts.project || deriveProjectId(cwd);

    const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
    if (!existing) {
      db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(projectId, projectId, cwd);
    }

    const rawJoined = stdoutChunks.join('').slice(0, 500) + stderrChunks.join('').slice(0, 500);
    const outputSummary = rawJoined ? redactSecrets(rawJoined) : undefined;

    const outcome: TestOutcomeRecord = {
      command: commandStr,
      passed: exitCode === 0 ? 1 : 0,
      failed: exitCode === 0 ? 0 : 1,
      skipped: 0,
      durationMs,
      runAt: startTime.toISOString(),
      rawOutputSummary: outputSummary || undefined,
    };

    const stored = collectTestOutcomes(storage, [outcome], projectId);

    if (stored > 0) {
      const sessions = db.prepare('SELECT id FROM sessions WHERE project_id = ?').all(projectId) as { id: string }[];
      for (const session of sessions) {
        correlateSession(storage, session.id);
      }
    }

    const outcomeLabel = exitCode === 0 ? 'PASS' : 'FAIL';
    console.log('');
    console.log(`${outcomeLabel}  Command: ${commandStr}`);
    console.log(`      Exit code: ${exitCode}`);
    console.log(`      Duration: ${durationMs}ms`);
    console.log(`      Recorded as project: ${projectId}`);
    console.log('');
    console.log('Privacy: All data stays local. No telemetry or external services.');

    process.exit(exitCode);
  } catch (err) {
    if (err instanceof StorageError) {
      console.error('Error: ' + err.message);
    } else {
      console.error('Error recording test outcome: ' + (err instanceof Error ? err.message : String(err)));
    }
    process.exit(exitCode);
  } finally {
    storage?.close();
  }
}
