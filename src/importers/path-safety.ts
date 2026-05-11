/**
 * Path safety utilities for importers.
 *
 * Prevents path traversal, symlink escape, and ensures
 * importers only read within the configured source path.
 */

import { resolve, relative, isAbsolute } from 'node:path';
import { lstatSync, realpathSync, readdirSync, type Stats } from 'node:fs';

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

/**
 * Return the lstat for a path within root, throwing PathSafetyError if the
 * path is a symlink/junction whose real target escapes root.
 * Returns the Stats object on success.
 */
export function safeLstat(root: string, target: string): Stats {
  const resolvedRoot = resolve(root);
  // First check path containment via resolve
  safeResolvePath(root, target);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    const realPath = realpathSync(target);
    const rel = relative(resolvedRoot, realPath);
    if (rel.startsWith('..') || (isAbsolute(rel) && !rel.startsWith(resolvedRoot))) {
      throw new PathSafetyError(
        `Symlink escape detected: "${target}" resolves to "${realPath}" outside root "${resolvedRoot}"`,
      );
    }
  }
  return stat;
}

/**
 * Safe readdir that skips entries whose symlinks/junctions escape root.
 * Returns only entry names that are safe to descend into.
 */
export function safeReadDir(root: string, dirPath: string): string[] {
  const resolvedRoot = realpathSync(resolve(root));
  // dirPath itself must realpath inside root
  let resolvedDir: string;
  try {
    resolvedDir = realpathSync(resolve(dirPath));
  } catch {
    // Missing or unresolvable dir — return empty rather than bomb importer
    return [];
  }
  const dirRel = relative(resolvedRoot, resolvedDir);
  if (dirRel.startsWith('..') || isAbsolute(dirRel)) {
    throw new PathSafetyError(
      `Directory "${dirPath}" realpath "${resolvedDir}" escapes root "${resolvedRoot}"`,
    );
  }

  const entries = readdirSync(resolvedDir);
  const safe: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(resolvedDir, entry);
    try {
      const lst = lstatSync(fullPath);
      if (lst.isSymbolicLink() || lst.isDirectory()) {
        // realpath every directory-like entry before letting caller descend
        const real = realpathSync(fullPath);
        const rel = relative(resolvedRoot, real);
        if (rel.startsWith('..') || isAbsolute(rel)) continue;
      }
      safe.push(entry);
    } catch {
      // Cannot stat — skip
    }
  }
  return safe;
}

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}