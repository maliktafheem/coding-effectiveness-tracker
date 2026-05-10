/**
 * API contract types — single source of truth for all HTTP response shapes.
 *
 * Both the server (routes.ts) and the dashboard (types.ts) import from here.
 * Zero runtime impact: types only.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type ErrorResponse = { error: string };

export interface ScoreDimensionContract {
  name: string;
  value: number;
  weight: number;
  explanation: string;
  available: boolean;
}

export interface ScoreContract {
  aggregate: number;
  dimensions: ScoreDimensionContract[];
  missingInputs: string[];
}

export interface DateRange {
  from: string | null;
  to: string | null;
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// GET /api/available-tools
// ---------------------------------------------------------------------------

export interface AvailableToolEntry {
  id: string;
  name: string;
  sessionCount: number;
}

export interface AvailableToolsResponse {
  tools: AvailableToolEntry[];
}

// ---------------------------------------------------------------------------
// GET /api/overview
// ---------------------------------------------------------------------------

export interface OverviewResponse {
  totalSessions: number;
  /** Array of source_tool_id strings present in the filtered session set. */
  tools: string[];
  dateRange: DateRange;
  outcomeCount: number;
  score: ScoreContract;
  empty: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// GET /api/timeline
// ---------------------------------------------------------------------------

/** One row in the timeline list. */
export interface TimelineSessionItem {
  id: string;
  sourceToolId: string;
  projectId: string | null;
  externalId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  model: string | null;
  correlationCount: number;
  outcomeCount: number;
  outcomeLabels: string[];
  hasOutcome: boolean;
  reworkCount: number;
}

export interface TimelineResponse {
  sessions: TimelineSessionItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// GET /api/tools
// ---------------------------------------------------------------------------

export interface ToolComparisonItem {
  toolId: string;
  sessionCount: number;
  outcomeCount: number;
  score: number;
}

export interface ToolsResponse {
  tools: ToolComparisonItem[];
}

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

export interface ProjectItem {
  projectId: string;
  sessionCount: number;
}

export interface ProjectsResponse {
  projects: ProjectItem[];
}

// ---------------------------------------------------------------------------
// GET /api/trends
// ---------------------------------------------------------------------------

export interface TrendPointContract {
  weekStart: string;
  weekEnd: string;
  sessionCount: number;
  sessionsWithGit: number;
  totalTestsPassed: number;
  totalTestsFailed: number;
  scoreAggregate: number;
}

export interface TrendsResponse {
  points: TrendPointContract[];
  period: DateRange;
}

// ---------------------------------------------------------------------------
// GET /api/sessions/:id
// ---------------------------------------------------------------------------

export interface CorrelationItem {
  id: string;
  type: string;
  targetId: string | null;
  confidence: number;
  reasons: string[];
}

export interface OutcomeItem {
  id: string;
  type: string;
  label: string;
  score: number | null;
  note: string | null;
}

export interface SessionDetailResponse {
  id: string;
  sourceToolId: string;
  projectId: string | null;
  externalId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  model: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costEstimate: number | null;
  metadata: Record<string, unknown> | null;
  reworkCount: number;
  correlations: CorrelationItem[];
  outcomes: OutcomeItem[];
  uncorrelated: boolean;
}

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/annotations
// ---------------------------------------------------------------------------

export interface AnnotationCreateResponse {
  id: string;
  sessionId: string;
  outcome: string;
  score: number | null;
  note: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// PATCH /api/annotations/:id
// ---------------------------------------------------------------------------

export interface AnnotationPatchResponse {
  id: string;
  sessionId: string;
  outcome: string;
  score: number | null;
  note: string | null;
}

// ---------------------------------------------------------------------------
// GET /api/export/json
// GET /api/export/markdown  (returns text/markdown — no JSON contract needed)
// ---------------------------------------------------------------------------

export interface JsonExportResponse {
  score: ScoreContract;
  /** Sessions are enriched with correlations/outcomes; raw shape kept open. */
  sessions: Record<string, unknown>[];
  tools: string[];
  totalSessions: number;
  period: DateRange;
  empty: boolean;
  generatedAt: string;
}
