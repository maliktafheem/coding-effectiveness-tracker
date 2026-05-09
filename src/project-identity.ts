/**
 * Project identity normalization.
 *
 * Provides cross-platform path normalization and stable project key
 * derivation to avoid merging unrelated repositories that share the
 * same directory name.
 */

import { createHash } from 'node:crypto';

/**
 * Normalize a project path for cross-platform identity comparison.
 * - Resolves to absolute
 * - Lowercases the path
 * - Normalizes separators to forward slashes
 * - Strips trailing separators
 * - Handles Windows drive letters consistently
 */
export function normalizeProjectPath(rawPath: string): string {
  let normalized = rawPath
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/\/+$/, '');

  // Normalize Windows drive letter: C:/Users/... → /c/Users/...
  if (/^[a-z]:/.test(normalized)) {
    normalized = '/' + normalized.charAt(0) + normalized.slice(2);
  }

  // Remove leading slash for consistent comparison
  normalized = normalized.replace(/^\//, '');

  return normalized;
}

/**
 * Derive a stable project ID from a full path.
 * Uses the basename plus a truncated hash of the full normalized path
 * to prevent collisions between different repos with the same folder name.
 *
 * Example:
 *   /home/user/projects/my-app → my-app-a3f2b1c9
 *   C:\Users\user\projects\my-app → my-app-d4e5f6a7
 */
export function deriveProjectId(fullPath: string): string {
  const normalized = normalizeProjectPath(fullPath);
  const basename = normalized.split('/').pop() || normalized;

  // Sanitize basename: lowercase, letters/numbers/hyphens only
  const cleanName = basename.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);

  return `${cleanName}-${hash}`;
}

/**
 * Derive a human-readable display name from a path.
 * Returns the last path component.
 */
export function deriveProjectName(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}
