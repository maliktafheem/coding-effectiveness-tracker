export interface Session {
  id: string;
  sourceToolId: string;
  startedAt: string | null;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  eventType: string;
  occurredAt: string | null;
  summary: string | null;
  metadataJson: string | null;
}

export interface AnalyzerInput {
  session: Session;
  events: SessionEvent[];
}

export interface PromptQualityResult {
  overall: number;
  signals: Record<string, number>;
  narrative?: string;
  analyzerId: string;
  analyzerVersion: string;
  computedAt: string;
}

export interface PromptAnalyzer {
  readonly id: string;
  readonly version: string;
  analyze(input: AnalyzerInput): Promise<PromptQualityResult>;
}
