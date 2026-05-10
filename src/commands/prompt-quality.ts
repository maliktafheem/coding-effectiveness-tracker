import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage } from '../storage.js';
import {
  computeAll,
  computeSingle,
  getAllResults,
  getResult,
  type StoredResult,
} from '../analytics/prompt-quality/service.js';

interface PromptQualityOptions {
  dataDir?: string;
  session?: string;
  recompute?: boolean;
  top?: string;
  worst?: string;
  analyzer?: string;
}

export async function handlePromptQuality(opts: PromptQualityOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  ensureInitialized(dataDir);
  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });

    if (opts.session) {
      // --session mode: compute (or fetch) and print one
      try {
        const result = await computeSingle(storage, opts.session, {
          recompute: opts.recompute === true,
          analyzerId: opts.analyzer,
        });
        if (!result) {
          process.stderr.write(`Session not found: ${opts.session}\n`);
          process.exitCode = 1;
          return;
        }
        printDetail(opts.session, result);
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(msg + '\n');
        process.exitCode = 1;
        return;
      }
    }

    // Batch mode: compute all, then optionally top/worst
    let summary;
    try {
      summary = await computeAll(storage, {
        recompute: opts.recompute === true,
        analyzerId: opts.analyzer,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(msg + '\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Computed ${summary.computed} session(s), skipped ${summary.skipped} (already cached).\n`,
    );

    const all = getAllResults(storage);
    if (all.length === 0) {
      process.stdout.write('No results yet.\n');
      return;
    }

    if (opts.top) {
      const n = parseInt(opts.top, 10);
      if (!Number.isNaN(n) && n > 0) {
        const sorted = [...all].sort((a, b) => b.overall - a.overall).slice(0, n);
        process.stdout.write(`\nTop ${Math.min(n, sorted.length)} prompts:\n`);
        for (const r of sorted) printRow(r);
        return;
      }
    }
    if (opts.worst) {
      const n = parseInt(opts.worst, 10);
      if (!Number.isNaN(n) && n > 0) {
        const sorted = [...all].sort((a, b) => a.overall - b.overall).slice(0, n);
        process.stdout.write(`\nWorst ${Math.min(n, sorted.length)} prompts:\n`);
        for (const r of sorted) printRow(r);
        return;
      }
    }

    const avg = all.reduce((acc, r) => acc + r.overall, 0) / all.length;
    process.stdout.write(
      `\nAverage quality: ${(avg * 100).toFixed(1)}%  (${all.length} session(s) scored)\n`,
    );
  } finally {
    storage?.close();
  }
}

function printDetail(
  sessionId: string,
  result: NonNullable<ReturnType<typeof getResult>>,
): void {
  process.stdout.write(`Session: ${sessionId}\n`);
  process.stdout.write(
    `Overall: ${(result.overall * 100).toFixed(1)}%  (analyzer: ${result.analyzerId}@${result.analyzerVersion})\n`,
  );
  process.stdout.write('\nSignals:\n');
  for (const [name, value] of Object.entries(result.signals)) {
    process.stdout.write(`  ${name.padEnd(16)} ${(value * 100).toFixed(0)}%\n`);
  }
}

function printRow(r: StoredResult): void {
  process.stdout.write(
    `  ${(r.overall * 100).toFixed(0).padStart(3)}% ${r.sessionId.slice(0, 8)}  ${r.toolId}  ${r.startedAt ?? '-'}\n`,
  );
}
