import type { PromptAnalyzer } from './types.js';
import { HeuristicV1 } from './heuristic-v1.js';

const REGISTRY: Record<string, () => PromptAnalyzer> = {
  'heuristic-v1': () => new HeuristicV1(),
};

export function getAnalyzer(id = 'heuristic-v1'): PromptAnalyzer {
  const factory = REGISTRY[id];
  if (!factory) {
    throw new Error(`Unknown analyzer: ${id}. Available: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return factory();
}

export function registerAnalyzer(id: string, factory: () => PromptAnalyzer): void {
  REGISTRY[id] = factory;
}

export function listAnalyzers(): string[] {
  return Object.keys(REGISTRY);
}
