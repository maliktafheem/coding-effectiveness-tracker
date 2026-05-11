import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Must be hoisted before other imports
const mockCollect = vi.hoisted(() => vi.fn());
vi.mock('../src/collectors/test-outcomes.js', () => ({
  collectTestOutcomes: mockCollect,
  TestOutcomeRecord: {} as any,
}));

// Mock spawn to return canary output
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* Windows file locks */ }
}

describe('cet test command privacy', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-test-privacy-'));
    vi.clearAllMocks();

    // Mock spawn to emit canary output then close
    const mockChild = {
      stdout: {
        on: vi.fn((_event: string, cb: (chunk: Buffer) => void) => {
          cb(Buffer.from('CANARY_LEAK_TEST_MARKER_ALPHA_ZERO in output\n'));
        }),
      },
      stderr: {
        on: vi.fn((_event: string, cb: (chunk: Buffer) => void) => {
          cb(Buffer.from('stderr with CANARY_LEAK_TEST_MARKER_BETA_ZERO\n'));
        }),
      },
      on: vi.fn((_event: string, cb: (code: number) => void) => {
        cb(0); // exit code 0
      }),
    };
    mockSpawn.mockReturnValue(mockChild);
  });

  afterEach(() => {
    safeCleanup(tempDir);
    vi.restoreAllMocks();
  });

  it('redacts secrets from captured test stdout summary before persistence', async () => {
    const { handleTest } = await import('../src/commands/test.js');

    // Prevent process.exit from killing the test
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit blocked');
    }) as any);

    try {
      await handleTest({ dataDir: tempDir, args: ['echo', 'hello'] });
    } catch (e: any) {
      // Expected: process.exit throws
      expect(e.message).toBe('process.exit blocked');
    } finally {
      exitSpy.mockRestore();
    }

    // collectTestOutcomes should have been called with redacted record
    expect(mockCollect).toHaveBeenCalled();
    const callArgs = mockCollect.mock.calls[0];
    const records = callArgs[1] as Array<{ rawOutputSummary?: string }>;
    expect(records.length).toBe(1);
    const summary = records[0].rawOutputSummary || '';
    // Canary strings should be redacted
    expect(summary).not.toContain('CANARY_LEAK_TEST_MARKER_ALPHA_ZERO');
    expect(summary).not.toContain('CANARY_LEAK_TEST_MARKER_BETA_ZERO');
    // Should contain [REDACTED] replacement
    expect(summary).toContain('[REDACTED]');
  });
});
