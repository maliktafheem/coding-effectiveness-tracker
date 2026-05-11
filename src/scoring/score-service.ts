/**
 * Score service — single entry point for scoring computations.
 *
 * Loads scoring config (weights + thresholds) from the data dir and
 * dispatches to `computeEffectivenessScore`. Use this wherever you would
 * have called `computeEffectivenessScore` directly, so every surface
 * (dashboard, CLI, analytics) gets the same weights AND thresholds.
 */

import type { Storage } from '../storage.js';
import { loadScoringConfig, type ScoringConfig } from './config.js';
import {
  computeEffectivenessScore,
  type ScoreOptions,
  type EffectivenessScore,
} from './effectiveness.js';

export interface ScoreServiceOptions extends Omit<ScoreOptions, 'weights' | 'thresholds'> {
  dataDir: string;
}

export function computeScore(storage: Storage, opts: ScoreServiceOptions): EffectivenessScore {
  const cfg = loadScoringConfig(opts.dataDir);
  return computeEffectivenessScore(storage, {
    projectId: opts.projectId,
    toolId: opts.toolId,
    from: opts.from,
    to: opts.to,
    weights: cfg.weights,
    thresholds: cfg.thresholds,
  });
}

export function loadFullConfig(dataDir: string): ScoringConfig {
  return loadScoringConfig(dataDir);
}
