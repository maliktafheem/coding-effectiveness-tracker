/**
 * Scoring weight configuration.
 *
 * Users can override scoring weights by creating a `scoring.json`
 * file in the tracker data directory. Missing keys fall back to defaults.
 *
 * Default weights are balanced to emphasize objective signals
 * (git correlation, test outcomes) over subjective ones (manual outcomes).
 *
 * Example scoring.json:
 * ```json
 * {
 *   "weights": {
 *     "git-correlation": 0.30,
 *     "test-confidence": 0.30
 *   },
 *   "thresholds": {
 *     "activitySessionCap": 20,
 *     "costCeiling": 2.0
 *   }
 * }
 * ```
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from '../config.js';

export interface ScoringWeights {
  'activity-output': number;
  'git-correlation': number;
  'test-confidence': number;
  'manual-outcome': number;
  'cost-efficiency': number;
  'rework-indicator': number;
}

export interface ScoringThresholds {
  activitySessionCap: number;
  costCeiling: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  'activity-output': 0.15,
  'git-correlation': 0.25,
  'test-confidence': 0.25,
  'manual-outcome': 0.15,
  'cost-efficiency': 0.10,
  'rework-indicator': 0.10,
};

export const DEFAULT_THRESHOLDS: ScoringThresholds = {
  activitySessionCap: 10,
  costCeiling: 1.0,
};

export interface ScoringConfig {
  weights: ScoringWeights;
  thresholds: ScoringThresholds;
}

/**
 * Load scoring config from the data directory.
 * Returns defaults if no config file exists.
 * Validates weights and reports errors for invalid values.
 */
export function loadScoringConfig(dataDir?: string): ScoringConfig {
  const resolved = resolveDataDir(dataDir);
  const configPath = join(resolved, 'scoring.json');

  if (!existsSync(configPath)) {
    return { weights: { ...DEFAULT_WEIGHTS }, thresholds: { ...DEFAULT_THRESHOLDS } };
  }

  let raw: unknown;
  try {
    const content = readFileSync(configPath, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Failed to parse scoring.json (${message}), using defaults.`);
    return { weights: { ...DEFAULT_WEIGHTS }, thresholds: { ...DEFAULT_THRESHOLDS } };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error('Warning: scoring.json must be a JSON object, using defaults.');
    return { weights: { ...DEFAULT_WEIGHTS }, thresholds: { ...DEFAULT_THRESHOLDS } };
  }

  const obj = raw as Record<string, unknown>;
  const weights: Partial<ScoringWeights> = {};

  if (obj.weights && typeof obj.weights === 'object' && !Array.isArray(obj.weights)) {
    const userWeights = obj.weights as Record<string, unknown>;
    const validKeys = Object.keys(DEFAULT_WEIGHTS);
    const errors: string[] = [];

    for (const key of validKeys) {
      if (key in userWeights) {
        const value = userWeights[key];
        if (typeof value === 'number' && value >= 0 && value <= 1) {
          (weights as Record<string, number>)[key] = value;
        } else {
          errors.push(`"${key}" must be a number between 0 and 1 (got ${JSON.stringify(value)})`);
        }
      }
    }

    if (errors.length > 0) {
      console.error(`Warning: Invalid scoring.json weights:\n  ${errors.join('\n  ')}\nUsing defaults.`);
      return { weights: { ...DEFAULT_WEIGHTS }, thresholds: { ...DEFAULT_THRESHOLDS } };
    }
  }

  // Merge with defaults: user values override, missing keys use defaults
  const merged: ScoringWeights = { ...DEFAULT_WEIGHTS, ...weights };

  // Normalize weights so they sum to 1.0
  const total = Object.values(merged).reduce((sum, w) => sum + w, 0);
  if (total > 0 && Math.abs(total - 1) > 0.001) {
    for (const key of Object.keys(merged) as (keyof ScoringWeights)[]) {
      merged[key] = Math.round((merged[key] / total) * 1000) / 1000;
    }
  }

  // Parse thresholds
  const thresholds: ScoringThresholds = { ...DEFAULT_THRESHOLDS };
  if (obj.thresholds && typeof obj.thresholds === 'object' && !Array.isArray(obj.thresholds)) {
    const userThresholds = obj.thresholds as Record<string, unknown>;
    if (typeof userThresholds.activitySessionCap === 'number' && userThresholds.activitySessionCap > 0) {
      thresholds.activitySessionCap = userThresholds.activitySessionCap;
    }
    if (typeof userThresholds.costCeiling === 'number' && userThresholds.costCeiling > 0) {
      thresholds.costCeiling = userThresholds.costCeiling;
    }
  }

  return { weights: merged, thresholds };
}
