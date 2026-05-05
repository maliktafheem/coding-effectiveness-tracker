/**
 * Path safety utilities for importers.
 *
 * Prevents path traversal, symlink escape, and ensures
 * importers only read within the configured source path.
 */

import { resolve, relative, isAbsolute } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

/**
 * Resolve and validate that a path is within the allowed root.
 * Returns the resolved absolute path if safe.
 * Throws if the path escapes the root (via symlink, traversal, etc.).
 */
export function safeResolvePath(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(root, target);
  const rel = relative(resolvedRoot, resolvedTarget);

  // Check for traversal escape: if relative path starts with '..' it's outside root
  if (rel.startsWith('..') || rel === '' && target === '..') {
    throw new PathSafetyError(
      `Path traversal detected: "${target}" escapes root "${resolvedRoot}"`,
    );
  }

  // Check for absolute path injection
  if (isAbsolute(target)) {
    const relFromRoot = relative(resolvedRoot, target);
    if (relFromRoot.startsWith('..')) {
      throw new PathSafetyError(
        `Absolute path escape detected: "${target}" is outside root "${resolvedRoot}"`,
      );
    }
  }

  return resolvedTarget;
}

/**
 * Check that a path does not follow a symlink outside the root.
 * Uses lstat to detect symlinks before resolving.
 */
export function assertNoSymlinkEscape(root: string, target: string): void {
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      const realPath = realpathSync(target);
      const resolvedRoot = resolve(root);
      const rel = relative(resolvedRoot, realPath);
      if (rel.startsWith('..')) {
        throw new PathSafetyError(
          `Symlink escape detected: "${target}" points to "${realPath}" outside root "${resolvedRoot}"`,
        );
      }
    }
  } catch (err) {
    if (err instanceof PathSafetyError) throw err;
    // File doesn't exist — that's fine, caller handles missing files
  }
}

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}