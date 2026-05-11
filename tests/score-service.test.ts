/**
 * Tests for score-service — centralised weights + thresholds dispatch.
 *
 * Verifies that computeScore loads full config (weights AND thresholds)
 * from scoring.json and that custom thresholds propagate to dimension scores.
 * Also verifies that loadFullConfig returns the whole ScoringConfig shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../src/storage.js';
import { ensureDataDir } from '../src/config.js';
import { computeScore, loadFullConfig } from '../src/scoring/score-service.js';

function safeCleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows file locks */ }
}

describe('score-service', () => {
  let tempDir: string;
  let dataDir: string;
  let storage: Storage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-score-svc-'));
    dataDir = ensureDataDir(join(tempDir, 'data'));
    storage = Storage.open({ dataDir });
    const db = storage.db;
    db.prepare('INSERT OR IGNORE INTO tools (id, name, display_name) VALUES (?, ?, ?)').run('svc-tool', 'svc-tool', 'SVC Tool');
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('svc-proj', 'SVC Proj');
  });
  afterEach(() => { storage?.close(); safeCleanup(tempDir); });

  it('loads weights AND thresholds from scoring.json', () => {
    // Custom threshold: tight cap so activity saturates with 1 session (vs default 10)
    writeFileSync(join(dataDir, 'scoring.json'), JSON.stringify({
      thresholds: { activitySessionCap: 1 },
    }));

    // Insert two sessions
    storage.db.prepare(
      'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?,?,?,?,?,?,?,?)'
    ).run('s1', 'ext-s1', 'svc-tool', 'svc-proj', '2026-04-06T10:00:00Z', '2026-04-06T11:00:00Z', 3600000, 's1');
    storage.db.prepare(
      'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary) VALUES (?,?,?,?,?,?,?,?)'
    ).run('s2', 'ext-s2', 'svc-tool', 'svc-proj', '2026-04-07T10:00:00Z', '2026-04-07T11:00:00Z', 3600000, 's2');

    const score = computeScore(storage, { dataDir });

    // With activitySessionCap=1, 2 sessions → value should be 1.0 (saturated at 1/1)
    // With default cap=10, 2 sessions → value would be 0.2
    const activityDim = score.dimensions.find(d => d.name === 'activity-output');
    expect(activityDim).toBeDefined();
    expect(activityDim!.value).toBe(1.0);
    expect(activityDim!.explanation).toContain('2 AI session(s)');
    // Also confirm cost-efficiency etc are present
    expect(score.dimensions.length).toBeGreaterThanOrEqual(2);
  });

  it('loadFullConfig returns both weights and thresholds', () => {
    writeFileSync(join(dataDir, 'scoring.json'), JSON.stringify({
      weights: { 'activity-output': 0.5, 'git-correlation': 0.1, 'test-confidence': 0.1, 'manual-outcome': 0.1, 'cost-efficiency': 0.1, 'rework-indicator': 0.1 },
      thresholds: { activitySessionCap: 5, costCeiling: 2.0 },
    }));

    const cfg = loadFullConfig(dataDir);

    expect(cfg.weights['activity-output']).toBeCloseTo(0.5);
    expect(cfg.weights['git-correlation']).toBeCloseTo(0.1);
    expect(cfg.thresholds.activitySessionCap).toBe(5);
    expect(cfg.thresholds.costCeiling).toBe(2.0);
  });

  it('computeScore passes thresholds to cost dimension', () => {
    // Tight costCeiling so $0.08 session already scores poorly
    writeFileSync(join(dataDir, 'scoring.json'), JSON.stringify({
      thresholds: { costCeiling: 0.05 },
    }));

    storage.db.prepare(
      'INSERT INTO sessions (id, external_id, source_tool_id, project_id, started_at, ended_at, duration_ms, summary, cost_estimate) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run('s3', 'ext-s3', 'svc-tool', 'svc-proj', '2026-04-06T10:00:00Z', '2026-04-06T11:00:00Z', 3600000, 's3', 0.08);

    const score = computeScore(storage, { dataDir });

    const costDim = score.dimensions.find(d => d.name === 'cost-efficiency');
    expect(costDim).toBeDefined();
    expect(costDim!.available).toBe(true);
    // costCeiling=0.05, avgCost=0.08 → score = 1 - (0.08/0.05) = max(0, 1-1.6) = 0
    expect(costDim!.value).toBe(0);
  });
});
