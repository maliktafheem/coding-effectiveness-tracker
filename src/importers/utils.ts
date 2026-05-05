/**
 * Shared importer utilities (file parsing, etc.)
 */

import { readFileSync } from 'node:fs';

/**
 * Read and parse a JSONL file (one JSON object per line).
 * Skips malformed lines.
 */
export function readJsonl(filePath: string): { records: Record<string, unknown>[]; errors: string[] } {
  const records: Record<string, unknown>[] = [];
  const errors: string[] = [];

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      errors.push(`Line ${i + 1}: malformed JSON skipped`);
    }
  }

  return { records, errors };
}