/**
 * CLI compare command handler.
 *
 * Compares effectiveness metrics between two periods, projects, or tools.
 */

import { resolveDataDir, ensureInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { computeEffectivenessScore } from '../scoring/effectiveness.js';
import { loadScoringConfig } from '../scoring/config.js';

interface CompareOptions {
  dataDir?: string;
  project?: string;
  tool?: string;
  period?: string;
  from1?: string;
  to1?: string;
  from2?: string;
  to2?: string;
}

export async function handleCompare(opts: CompareOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  ensureInitialized(dataDir);

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
    const scoringConfig = loadScoringConfig(opts.dataDir);

    // Determine comparison mode
    if (opts.period === 'tools') {
      // Compare across tools
      const tools = ['claude-code', 'opencode', 'codex', 'cursor', 'factory-droid'];
      console.log('Tool Comparison');
      console.log('────────────────');
      console.log('');

      const results: { tool: string; sessions: number; score: number }[] = [];
      for (const tool of tools) {
        const sessions = storage!.db.prepare(
          "SELECT count(*) as cnt FROM sessions WHERE source_tool_id = ?"
        ).get(tool) as { cnt: number };
        if (sessions.cnt === 0) continue;

        const score = computeEffectivenessScore(storage!, {
          toolId: tool, projectId: opts.project,
          weights: scoringConfig.weights,
          thresholds: scoringConfig.thresholds,
        });
        results.push({ tool, sessions: sessions.cnt, score: score.aggregate });
        console.log(`${tool.padEnd(18)} ${String(sessions.cnt).padStart(4)} sessions  Score: ${Math.round(score.aggregate * 100)}%`);
      }
      if (results.length === 0) console.log('No sessions found for any tool.');

    } else if (opts.period === 'projects') {
      // Compare across projects
      const projects = storage!.db.prepare('SELECT id, name FROM projects ORDER BY id').all() as { id: string; name: string }[];
      console.log('Project Comparison');
      console.log('──────────────────');
      console.log('');

      for (const p of projects) {
        const sessions = storage!.db.prepare(
          "SELECT count(*) as cnt FROM sessions WHERE project_id = ?"
        ).get(p.id) as { cnt: number };
        if (sessions.cnt === 0) continue;

        const score = computeEffectivenessScore(storage!, {
          projectId: p.id, toolId: opts.tool,
          weights: scoringConfig.weights,
          thresholds: scoringConfig.thresholds,
        });
        console.log(`${(p.name || p.id).padEnd(25)} ${String(sessions.cnt).padStart(4)} sessions  Score: ${Math.round(score.aggregate * 100)}%`);
      }

    } else {
      // Default: compare two time periods
      const now = new Date();
      const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

      const period2Start = (opts.from2 || twoWeeksAgo.toISOString().slice(0, 10));
      const period2End = (opts.to2 || now.toISOString().slice(0, 10));
      const period1Start = (opts.from1 || fourWeeksAgo.toISOString().slice(0, 10));
      const period1End = (opts.to1 || twoWeeksAgo.toISOString().slice(0, 10));

      const baseOpts = { projectId: opts.project, toolId: opts.tool, weights: scoringConfig.weights, thresholds: scoringConfig.thresholds };
      const score1 = computeEffectivenessScore(storage!, { ...baseOpts, from: period1Start, to: period1End });
      const score2 = computeEffectivenessScore(storage!, { ...baseOpts, from: period2Start, to: period2End });

      console.log('Period Comparison');
      console.log('─────────────────');
      console.log('');
      console.log(`Period 1: ${period1Start} → ${period1End}`);
      console.log(`  Sessions: ${score1.sessionCount}`);
      console.log(`  Score:    ${Math.round(score1.aggregate * 100)}%`);
      console.log('');
      console.log(`Period 2: ${period2Start} → ${period2End}`);
      console.log(`  Sessions: ${score2.sessionCount}`);
      console.log(`  Score:    ${Math.round(score2.aggregate * 100)}%`);
      console.log('');

      const diff = Math.round((score2.aggregate - score1.aggregate) * 100);
      const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
      console.log(`Change: ${arrow} ${Math.abs(diff)}pp`);
    }

    console.log('');
    console.log('Privacy: All data stays local. No telemetry or external services.');
  } finally {
    storage?.close();
  }
}
