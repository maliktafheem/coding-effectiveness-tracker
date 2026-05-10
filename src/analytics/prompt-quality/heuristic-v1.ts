import type { AnalyzerInput, PromptAnalyzer, PromptQualityResult } from './types.js';

const WEIGHTS = {
  specificity: 0.35,
  iteration: 0.30,
  hasCodeBlock: 0.15,
  hasExample: 0.10,
  hasConstraint: 0.10,
};

export class HeuristicV1 implements PromptAnalyzer {
  readonly id = 'heuristic-v1';
  readonly version = '1.0.0';

  async analyze(input: AnalyzerInput): Promise<PromptQualityResult> {
    const firstUser = input.events.find((e) => e.eventType === 'user-message');
    const firstText = firstUser?.summary ?? '';
    const assistantTurns = input.events.filter((e) => e.eventType === 'assistant-message').length;

    const words = firstText.trim().split(/\s+/).filter(Boolean).length;
    const specificity = Math.min(1, words / 200);
    const iteration = Math.max(0, 1 - assistantTurns / 10);
    const hasCodeBlock = /```/.test(firstText) ? 1 : 0;
    const hasExample = /(e\.g\.|example:|for instance)/i.test(firstText) ? 1 : 0;
    const hasConstraint = /(don't|must|avoid|only|ensure)/i.test(firstText) ? 1 : 0;

    const signals = { specificity, iteration, hasCodeBlock, hasExample, hasConstraint };
    const overall =
      specificity * WEIGHTS.specificity +
      iteration * WEIGHTS.iteration +
      hasCodeBlock * WEIGHTS.hasCodeBlock +
      hasExample * WEIGHTS.hasExample +
      hasConstraint * WEIGHTS.hasConstraint;

    return {
      overall: Math.max(0, Math.min(1, overall)),
      signals,
      analyzerId: this.id,
      analyzerVersion: this.version,
      computedAt: new Date().toISOString(),
    };
  }
}
