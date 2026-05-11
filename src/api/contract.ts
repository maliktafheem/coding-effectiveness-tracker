/**
 * API contract types — single source of truth for all HTTP response shapes.
 *
 * Both the server (routes.ts) and the dashboard (types.ts) import from here.
 * Zero runtime impact: types only.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

import type { ShipStatus } from '../correlation/ship-status.js';
export type { ShipStatus };

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
  dataCompleteness?: number;
  evidenceLevel?: 'insufficient' | 'partial' | 'strong';
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

export interface ShipStatusBreakdown {
  shipped: number;
  reverted: number;
  abandoned: number;
  inFlight: number;
  unlinked: number;
  noPrData: number;
}

export interface OverviewResponse {
  totalSessions: number;
  /** Array of source_tool_id strings present in the filtered session set. */
  tools: string[];
  dateRange: DateRange;
  outcomeCount: number;
  score: ScoreContract;
  empty: boolean;
  message?: string;
  shipStatusBreakdown: ShipStatusBreakdown;
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
  shipStatus: ShipStatus | null;
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

export interface SessionPrItem {
  prNumber: number;
  state: 'merged' | 'closed' | 'open';
  title: string;
  url: string;
  mergedAt: string | null;
  closedAt: string | null;
  reverted: boolean;
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
  promptQuality?: PromptQualityContract;
  shipStatus: ShipStatus | null;
  prs: SessionPrItem[];
}

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/diff
// ---------------------------------------------------------------------------

export interface DiffStatsContract {
  files: number;
  insertions: number;
  deletions: number;
}

export interface CommitDiffItem {
  hash: string;
  shortHash: string;
  message: string | null;
  stats: DiffStatsContract;
  diff?: string;
  skipped?: 'too-large' | 'repo-missing';
}

export interface SessionDiffResponse {
  commits: CommitDiffItem[];
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
// GET /api/prompt-quality
// ---------------------------------------------------------------------------

export interface PromptQualitySessionItem {
  sessionId: string;
  toolId: string;
  startedAt: string | null;
  overall: number;
  signals: Record<string, number>;
  analyzerId: string;
  analyzerVersion: string;
  computedAt: string;
}

export interface PromptQualityResponse {
  sessions: PromptQualitySessionItem[];
  avgOverall: number;
  analyzer: string;
}

export interface PromptQualityContract {
  overall: number;
  signals: Record<string, number>;
  analyzerId: string;
  analyzerVersion: string;
  computedAt: string;
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
