import { describe, it, expect } from 'vitest';
import { HeuristicV1 } from '../src/analytics/prompt-quality/heuristic-v1.js';
import { getAnalyzer, registerAnalyzer, listAnalyzers } from '../src/analytics/prompt-quality/registry.js';
import type { Session, SessionEvent, PromptAnalyzer } from '../src/analytics/prompt-quality/types.js';

function makeSession(): Session {
  return { id: 's1', sourceToolId: 't1', startedAt: '2026-01-01T00:00:00Z' };
}

function userEvent(text: string, at = '2026-01-01T00:00:00Z'): SessionEvent {
  return { id: 'e', sessionId: 's1', eventType: 'user-message', occurredAt: at, summary: text, metadataJson: null };
}

function assistantEvent(at = '2026-01-01T00:00:10Z'): SessionEvent {
  return { id: 'e', sessionId: 's1', eventType: 'assistant-message', occurredAt: at, summary: 'ok', metadataJson: null };
}

describe('HeuristicV1', () => {
  const analyzer = new HeuristicV1();

  it('id and version set', () => {
    expect(analyzer.id).toBe('heuristic-v1');
    expect(analyzer.version).toMatch(/\d+\.\d+/);
  });

  it('returns near-zero for empty prompt and no assistant turns', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent('')] });
    // specificity=0, iteration=1, no code/example/constraint → 0*0.35 + 1*0.30 = 0.30
    expect(r.overall).toBeCloseTo(0.30, 2);
    expect(r.signals.specificity).toBe(0);
  });

  it('rewards specific long prompts (max at 200 words)', async () => {
    const text = 'x '.repeat(250);
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent(text)] });
    expect(r.signals.specificity).toBeCloseTo(1, 2);
  });

  it('detects code block', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent('do this\n```js\nx()\n```')] });
    expect(r.signals.hasCodeBlock).toBe(1);
  });

  it('detects example', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent('convert, e.g. foo bar')] });
    expect(r.signals.hasExample).toBe(1);
  });

  it('detects constraint', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent("don't use X")] });
    expect(r.signals.hasConstraint).toBe(1);
  });

  it('iteration penalizes many assistant turns', async () => {
    const events = [userEvent('hi')];
    for (let i = 0; i < 15; i++) events.push(assistantEvent());
    const r = await analyzer.analyze({ session: makeSession(), events });
    expect(r.signals.iteration).toBe(0);
  });

  it('overall is weighted sum in [0,1]', async () => {
    const r = await analyzer.analyze({
      session: makeSession(),
      events: [userEvent("Please refactor auth. Don't break tests. e.g.\n```ts\nfoo()\n```")],
    });
    expect(r.overall).toBeGreaterThan(0.4);
    expect(r.overall).toBeLessThanOrEqual(1);
  });

  it('no acceptance/rework signal (avoids circular dep with scoring)', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent('test')] });
    expect(r.signals).not.toHaveProperty('acceptance');
    expect(r.signals).not.toHaveProperty('rework');
  });

  it('returns analyzer identity fields', async () => {
    const r = await analyzer.analyze({ session: makeSession(), events: [userEvent('hi')] });
    expect(r.analyzerId).toBe('heuristic-v1');
    expect(r.analyzerVersion).toBe('1.0.0');
    expect(r.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('analyzer registry', () => {
  it('getAnalyzer returns HeuristicV1 by default', () => {
    const a = getAnalyzer();
    expect(a.id).toBe('heuristic-v1');
  });

  it('getAnalyzer throws for unknown id', () => {
    expect(() => getAnalyzer('does-not-exist')).toThrow(/Unknown analyzer/);
  });

  it('registerAnalyzer allows adding new analyzers', () => {
    class Custom implements PromptAnalyzer {
      readonly id = 'test-custom';
      readonly version = '0.1.0';
      async analyze() {
        return {
          overall: 0.5, signals: {}, analyzerId: this.id, analyzerVersion: this.version, computedAt: 'x',
        };
      }
    }
    registerAnalyzer('test-custom', () => new Custom());
    expect(listAnalyzers()).toContain('test-custom');
    expect(getAnalyzer('test-custom').id).toBe('test-custom');
  });
});