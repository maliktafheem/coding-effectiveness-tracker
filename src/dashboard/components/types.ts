/**
 * Dashboard-local types plus re-exports of the shared API contract.
 *
 * Runtime-aligned shapes live in contract.ts. Only dashboard-only types
 * (navigation state, etc.) are declared here.
 */

export type {
  OverviewResponse as OverviewData,
  TimelineSessionItem as TimelineSession,
  SessionDetailResponse as SessionDetail,
  ToolComparisonItem as ToolComparison,
  ProjectItem as ProjectInfo,
  TrendsResponse as TrendData,
} from '../../api/contract.js';

/** Dashboard navigation pages. */
export type Page = 'overview' | 'timeline' | 'tools' | 'export';
