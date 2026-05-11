import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Must be hoisted before other imports
const mockCollect = vi.hoisted(() => vi.fn());
vi.mock('../src/collectors/test-outcomes.js', () => ({
  collectTestOutcomes: mockCollect,
  TestOutcomeRecord: {} as any,
}));

function safeCleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* Windows file locks */ }
}

describe('cet test-outcome zod validation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cet-test-outcome-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    safeCleanup(tempDir);
    vi.restoreAllMocks();
  });

  describe('inline mode validation', () => {
    it('rejects negative --passed with exit code 1 and stderr mentioning "passed"', async () => {
      const { handleTestOutcome } = await import('../src/commands/test-outcome.js');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit blocked');
      }) as any);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handleTestOutcome({
          dataDir: tempDir,
          command: 'npm test',
          passed: '-1',
          failed: '0',
        });
        expect.unreachable('Expected process.exit to be called');
      } catch (e: any) {
        expect(e.message).toBe('process.exit blocked');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const errOutput = errorSpy.mock.calls.map(c => String(c[0])).join('');
        expect(errOutput).toMatch(/passed/i);
      } finally {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('rejects negative --failed with exit code 1 and stderr mentioning "failed"', async () => {
      const { handleTestOutcome } = await import('../src/commands/test-outcome.js');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit blocked');
      }) as any);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handleTestOutcome({
          dataDir: tempDir,
          command: 'npm test',
          passed: '5',
          failed: '-1',
        });
        expect.unreachable('Expected process.exit to be called');
      } catch (e: any) {
        expect(e.message).toBe('process.exit blocked');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const errOutput = errorSpy.mock.calls.map(c => String(c[0])).join('');
        expect(errOutput).toMatch(/failed/i);
      } finally {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('rejects non-ISO --run-at with exit code 1 and stderr mentioning "runAt"', async () => {
      const { handleTestOutcome } = await import('../src/commands/test-outcome.js');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit blocked');
      }) as any);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handleTestOutcome({
          dataDir: tempDir,
          command: 'npm test',
          passed: '5',
          failed: '0',
          runAt: 'not-a-date',
        });
        expect.unreachable('Expected process.exit to be called');
      } catch (e: any) {
        expect(e.message).toBe('process.exit blocked');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const errOutput = errorSpy.mock.calls.map(c => String(c[0])).join('');
        expect(errOutput).toMatch(/runAt/i);
      } finally {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('accepts valid inline inputs and calls collectTestOutcomes', async () => {
      const { handleTestOutcome } = await import('../src/commands/test-outcome.js');
      mockCollect.mockReturnValue(1);

      await handleTestOutcome({
        dataDir: tempDir,
        command: 'npm test',
        passed: '5',
        failed: '1',
        skipped: '2',
        duration: '3000',
        runAt: '2024-06-15T10:30:00Z',
      });

      expect(mockCollect).toHaveBeenCalled();
      const records = mockCollect.mock.calls[0][1];
      expect(records.length).toBe(1);
      expect(records[0].passed).toBe(5);
      expect(records[0].failed).toBe(1);
      expect(records[0].skipped).toBe(2);
      expect(records[0].durationMs).toBe(3000);
      expect(records[0].runAt).toBe('2024-06-15T10:30:00Z');
    });
  });

  describe('JSON file mode validation', () => {
    it('rejects JSON record with negative count with exit code 1 and stderr mentioning "passed"', async () => {
      const { handleTestOutcome } = await import('../src/commands/test-outcome.js');

      const jsonPath = join(tempDir, 'outcomes.json');
      writeFileSync(jsonPath, JSON.stringify([
        { command: 'npm test', passed: -1, failed: 0, runAt: '2024-06-15T10:30:00Z' },
      ]), 'utf-8');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit blocked');
      }) as any);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await handleTestOutcome({
          dataDir: tempDir,
          outcomeJson: jsonPath,
        });
        expect.unreachable('Expected process.exit to be called');
      } catch (e: any) {
        expect(e.message).toBe('process.exit blocked');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const errOutput = errorSpy.mock.calls.map(c => String(c[0])).join('');
        expect(errOutput).toMatch(/passed/i);
      } finally {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
