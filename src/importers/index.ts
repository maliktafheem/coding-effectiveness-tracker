/**
 * Importer module barrel export.
 *
 * Re-exports all public types, the registry, privacy utilities,
 * path safety helpers, and all built-in tool importers.
 */

export type { NormalizedSession, NormalizedEvent, ImportResult, ImportOptions, ToolImporter } from './types.js';
export { registerImporter, registerAllImporters, getImporters, getImporter, discoverImporters, runImport, runFixtureImport, importFromTool, importAll } from './registry.js';
export { readJsonl } from './utils.js';
export { redactSecrets, redactMetadata, findCanaryLeaks, sanitizeForOutput, CANARY_SECRETS, ALL_CANARIES } from './privacy.js';
export { safeResolvePath, assertNoSymlinkEscape, PathSafetyError } from './path-safety.js';
export { ClaudeCodeImporter } from './claude-code.js';
export { CodexImporter } from './codex.js';
export { OpenCodeImporter } from './opencode.js';
export { FactoryDroidImporter } from './factory-droid.js';
export { CursorImporter } from './cursor.js';

// Auto-register all built-in importers when this module is loaded.
import { registerAllImporters } from './registry.js';
registerAllImporters();