/**
 * Common types and interfaces for the importer framework.
 */

/** Parsed session record ready for normalization into the DB schema. */
export interface NormalizedSession {
  externalId: string;
  sourceToolId: string;
  projectId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  summary?: string;
  model?: string;
  tokensInput?: number;
  tokensOutput?: number;
  costEstimate?: number;
  metadata?: Record<string, unknown>;
  events?: NormalizedEvent[];
}

export interface NormalizedEvent {
  eventType: string;
  occurredAt?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

/** Result of an import run. */
export interface ImportResult {
  sourceToolId: string;
  sourcePath: string;
  imported: number;
  skipped: number;
  errors: number;
  errorDetails: string[];
  sessions: NormalizedSession[];
}

/** Options for running an importer. */
export interface ImportOptions {
  /** Absolute path to the source directory or file. */
  sourcePath: string;
  /** Only validate and report; do not write to storage. */
  dryRun?: boolean;
  /** Only import sessions newer than this ISO timestamp. */
  since?: string;
}

/** Interface that all tool importers must implement. */
export interface ToolImporter {
  /** Tool identifier matching the tools table id. */
  readonly toolId: string;
  /** Human-readable display name. */
  readonly displayName: string;

  /**
   * Detect whether the given path contains recognizable data for this tool.
   * Returns true if the importer should attempt to read from this path.
   */
  canHandle(sourcePath: string): boolean;

  /**
   * Parse and normalize sessions from the source path.
   * Does NOT write to storage — returns normalized records only.
   */
  parse(options: ImportOptions): ImportResult;
}