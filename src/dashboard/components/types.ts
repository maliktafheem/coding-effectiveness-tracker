export interface OverviewData {
  totalSessions: number;
  tools: string[];
  dateRange: { from: string | null; to: string | null };
  outcomeCount: number;
  score: { aggregate: number; dimensions: { name: string; value: number; explanation: string; available: boolean; weight: number }[]; missingInputs: string[] };
  empty: boolean;
  message?: string;
}

export interface TimelineSession {
  id: string; sourceToolId: string; projectId: string | null;
  startedAt: string; endedAt: string | null; durationMs: number | null;
  summary: string | null; model: string | null;
  correlationCount: number;
  outcomeCount: number;
  outcomeLabels: string[];
  hasOutcome: boolean;
  reworkCount: number;
}

export interface SessionDetail extends TimelineSession {
  externalId: string | null; tokensInput: number | null; tokensOutput: number | null;
  costEstimate: number | null; metadata: Record<string, unknown> | null;
  correlations: { id: string; type: string; targetId: string; confidence: number; reasons: string[] }[];
  outcomes: { id: string; type: string; label: string; score: number | null; note: string | null }[];
  uncorrelated: boolean;
}

export interface ToolComparison {
  toolId: string; sessionCount: number; outcomeCount: number; score: number;
}

export interface ProjectInfo {
  projectId: string; sessionCount: number;
}

export type Page = 'overview' | 'timeline' | 'tools' | 'export';
