import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getImporters, loadPluginImporters } from '../src/importers/registry.js';

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best effort cleanup for Windows file locks
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) safeCleanup(dir);
  }
});

describe('plugin importer loading gate', () => {
  it('does not load plugins when enablePlugins is false (default)', async () => {
    const pluginId = `test-plugin-disabled-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const root = mkdtempSync(join(tmpdir(), 'cet-plugin-disabled-'));
    tempDirs.push(root);

    const pluginsDir = join(root, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, 'test-plugin.js'),
      `throw new Error('plugin import should not run when disabled');\n` +
      `export default class TestPlugin {\n` +
      `  constructor() { this.toolId = '${pluginId}'; this.displayName = 'Test Plugin'; }\n` +
      `  canHandle() { return false; }\n` +
      `  parse() { return { sourceToolId: '${pluginId}', sourcePath: '', imported: 0, skipped: 0, errors: 0, errorDetails: [], sessions: [] }; }\n` +
      `}\n`,
      'utf-8',
    );

    const loaded = await loadPluginImporters(pluginsDir, { enablePlugins: false });

    expect(loaded).toBe(0);
    expect(getImporters().some((imp) => imp.toolId === pluginId)).toBe(false);
  });

  it('loads plugins when enablePlugins is true', async () => {
    const pluginId = `test-plugin-enabled-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const root = mkdtempSync(join(tmpdir(), 'cet-plugin-enabled-'));
    tempDirs.push(root);

    const pluginsDir = join(root, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, 'test-plugin.mjs'),
      `export default class TestPlugin {\n` +
      `  constructor() { this.toolId = '${pluginId}'; this.displayName = 'Test Plugin'; }\n` +
      `  canHandle() { return false; }\n` +
      `  parse() { return { sourceToolId: '${pluginId}', sourcePath: '', imported: 0, skipped: 0, errors: 0, errorDetails: [], sessions: [] }; }\n` +
      `}\n`,
      'utf-8',
    );

    const loaded = await loadPluginImporters(pluginsDir, { enablePlugins: true });

    expect(loaded).toBe(1);
    expect(getImporters().some((imp) => imp.toolId === pluginId)).toBe(true);
  });
});
