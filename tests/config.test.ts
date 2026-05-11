import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDataDir, ensureDataDir, isInitialized } from '../src/config.js';
import vitestConfig from '../vitest.config.ts';

describe('vitest config', () => {
  it('does not set global retry', () => {
    expect(vitestConfig.test?.retry).toBeUndefined();
    expect((vitestConfig.test as Record<string, unknown> | undefined)?.testRetries).toBeUndefined();
  });
});

describe('config - data directory resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-config-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses explicit path when provided', () => {
    const custom = join(tempDir, 'my-data');
    const resolved = resolveDataDir(custom);
    expect(resolved).toBe(custom);
  });

  it('resolves relative explicit paths to absolute', () => {
    const relative = join('relative', 'path');
    const resolved = resolveDataDir(relative);
    expect(isAbsolute(resolved)).toBe(true);
  });

  it('uses CET_DATA_DIR env when no explicit option', () => {
    const envDir = join(tempDir, 'env-data');
    const original = process.env.CET_DATA_DIR;
    try {
      process.env.CET_DATA_DIR = envDir;
      const resolved = resolveDataDir();
      expect(resolved).toBe(envDir);
    } finally {
      if (original === undefined) {
        delete process.env.CET_DATA_DIR;
      } else {
        process.env.CET_DATA_DIR = original;
      }
    }
  });

  it('resolves relative CET_DATA_DIR env to absolute', () => {
    const original = process.env.CET_DATA_DIR;
    try {
      process.env.CET_DATA_DIR = 'some/relative';
      const resolved = resolveDataDir();
      expect(resolved).toContain('some');
      expect(resolved).toContain('relative');
      expect(isAbsolute(resolved)).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.CET_DATA_DIR;
      } else {
        process.env.CET_DATA_DIR = original;
      }
    }
  });

  it('falls back to platform default when no explicit or env', () => {
    const original = process.env.CET_DATA_DIR;
    try {
      delete process.env.CET_DATA_DIR;
      const resolved = resolveDataDir();
      expect(resolved).toBeTruthy();
      expect(resolved).toContain('coding-effectiveness-tracker');
    } finally {
      if (original === undefined) {
        delete process.env.CET_DATA_DIR;
      } else {
        process.env.CET_DATA_DIR = original;
      }
    }
  });

  it('handles paths with spaces', () => {
    const spaced = join(tempDir, 'my data dir');
    const resolved = resolveDataDir(spaced);
    expect(resolved).toBe(spaced);
  });

  it('handles paths with parentheses', () => {
    const parens = join(tempDir, 'data (2)');
    const resolved = resolveDataDir(parens);
    expect(resolved).toBe(parens);
  });

  it('handles paths with unicode characters', () => {
    const unicode = join(tempDir, 'data-\u65E5\u672C\u8A9E');
    const resolved = resolveDataDir(unicode);
    expect(resolved).toBe(unicode);
  });
});

describe('config - ensureDataDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-ensure-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates data directory and subdirectories', () => {
    const dataDir = join(tempDir, 'my-workspace');
    const resolved = ensureDataDir(dataDir);
    expect(existsSync(resolved)).toBe(true);
    expect(existsSync(join(resolved, 'importers'))).toBe(true);
    expect(existsSync(join(resolved, 'exports'))).toBe(true);
    expect(existsSync(join(resolved, 'correlations'))).toBe(true);
  });

  it('is idempotent - does not fail on existing directories', () => {
    const dataDir = join(tempDir, 'my-workspace');
    ensureDataDir(dataDir);
    expect(() => ensureDataDir(dataDir)).not.toThrow();
    expect(existsSync(dataDir)).toBe(true);
  });
});

describe('config - isInitialized', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-init-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when tracker.db does not exist', () => {
    expect(isInitialized(tempDir)).toBe(false);
  });

  it('returns true when tracker.db exists', () => {
    writeFileSync(join(tempDir, 'tracker.db'), '');
    expect(isInitialized(tempDir)).toBe(true);
  });
});
