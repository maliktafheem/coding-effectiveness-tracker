import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../src/storage.js';

const CLI = resolve(process.cwd(), 'dist/cli.js');

function seed(storage: Storage, id: string, prompt: string): void {
  storage.db
    .prepare(
      'INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)',
    )
    .run('t', 't', 'T');
  storage.db
    .prepare(
      'INSERT INTO sessions (id, source_tool_id, started_at) VALUES (?, ?, ?)',
    )
    .run(id, 't', '2026-01-01T00:00:00Z');
  storage.db
    .prepare(
      'INSERT INTO events (id, session_id, event_type, occurred_at, summary, metadata_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(randomUUID(), id, 'user-message', '2026-01-01T00:00:00Z', prompt, null);
}

describe('cet prompt-quality CLI', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      execFileSync('npm', ['run', 'build'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        shell: true,
      });
    }
  });

  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cli-pq-'));
    const s = Storage.open({ dataDir });
    seed(s, 's1', "refactor auth module. e.g. remove jwt middleware. don't break tests.");
    seed(s, 's2', 'hi');
    s.close();
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it('batch mode prints computed count and average', () => {
    const out = execFileSync('node', [CLI, 'prompt-quality', '--data-dir', dataDir], {
      encoding: 'utf-8',
    });
    expect(out).toMatch(/Computed 2 session/);
    expect(out).toMatch(/Average quality/);
  });

  it('--session prints detail', () => {
    const out = execFileSync('node', [
      CLI,
      'prompt-quality',
      '--data-dir',
      dataDir,
      '--session',
      's1',
    ], { encoding: 'utf-8' });
    expect(out).toContain('Session: s1');
    expect(out).toContain('Signals:');
    expect(out).toMatch(/specificity/);
  });

  it('--top N prints top N in descending order', () => {
    const out = execFileSync('node', [
      CLI,
      'prompt-quality',
      '--data-dir',
      dataDir,
      '--top',
      '2',
    ], { encoding: 'utf-8' });
    expect(out).toMatch(/Top 2 prompts/);
    const lines = out.split('\n').filter((l) => /^\s+\d+%/.test(l));
    expect(lines.length).toBe(2);
  });

  it('--worst N sorts ascending', () => {
    const out = execFileSync('node', [
      CLI,
      'prompt-quality',
      '--data-dir',
      dataDir,
      '--worst',
      '1',
    ], { encoding: 'utf-8' });
    expect(out).toMatch(/Worst 1 prompts/);
  });

  it('exits 1 on unknown session', () => {
    expect(() =>
      execFileSync('node', [CLI, 'prompt-quality', '--data-dir', dataDir, '--session', 'does-not-exist'], {
        encoding: 'utf-8',
      }),
    ).toThrow();
  });
});
