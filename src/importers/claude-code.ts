/**
 * Claude Code local filesystem importer.
 *
 * Claude Code stores session data in ~/.claude or ~/.claude/projects directories.
 * Expected structure: JSONL files with session entries.
 *
 * Each line is a JSON object with fields like:
 * - sessionId, type, timestamp, message, model, cwd, etc.
 */

import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { ToolImporter, ImportOptions, ImportResult } from './types.js';
import { readJsonl } from './utils.js';
import { sanitizeForOutput } from './privacy.js';
import { safeReadDir } from './path-safety.js';

export class ClaudeCodeImporter implements ToolImporter {
  readonly toolId = 'claude-code';
  readonly displayName = 'Claude Code';

  canHandle(sourcePath: string): boolean {
    try {
      if (!existsSync(sourcePath)) return false;
      const stat = statSync(sourcePath);
      if (stat.isFile()) {
        return this.isClaudeFile(sourcePath);
      }
      const dirName = basename(sourcePath).toLowerCase();
      if (dirName === '.claude' || dirName === 'claude' || dirName === 'claude-code') return true;
      return this.hasClaudeFiles(sourcePath);
    } catch {
      return false;
    }
  }

  parse(options: ImportOptions): ImportResult {
    const { sourcePath } = options;
    const result: ImportResult = {
      sourceToolId: this.toolId,
      sourcePath,
      imported: 0,
      skipped: 0,
      errors: 0,
      errorDetails: [],
      sessions: [],
    };

    try {
      if (!existsSync(sourcePath)) {
        result.errors = 1;
        result.errorDetails.push(`Source path not found: ${sourcePath}`);
        return result;
      }

      const stat = statSync(sourcePath);
      const files = stat.isFile() ? [sourcePath] : this.findSessionFiles(sourcePath, sourcePath);

      for (const file of files) {
        this.parseFile(file, result);
      }
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errorDetails.push(`Claude Code parse error: ${sanitizeForOutput(msg)}`);
    }

    result.imported = result.sessions.length;
    return result;
  }

  private isClaudeFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    if (ext !== '.jsonl' && ext !== '.json' && ext !== '.log') return false;
    const name = basename(filePath).toLowerCase();
    return name.includes('conversation') || name.includes('claude');
  }

  private hasClaudeFiles(dirPath: string): boolean {
    try {
      const entries = readdirSync(dirPath);
      return entries.some((e) => {
        const lower = e.toLowerCase();
        return lower.includes('claude') && (lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.log'));
      });
    } catch {
      return false;
    }
  }

  private findSessionFiles(dirPath: string, root: string): string[] {
    const files: string[] = [];
    try {
      const entries = safeReadDir(root, dirPath);
      for (const entry of entries) {
        const fullPath = join(dirPath, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile() && this.isClaudeFile(fullPath)) {
            files.push(fullPath);
          } else if (statSync(fullPath).isDirectory() && !entry.startsWith('.')) {
            const subEntries = safeReadDir(root, fullPath);
            for (const sub of subEntries) {
              const subPath = join(fullPath, sub);
              try {
                if (!lstatSync(subPath).isSymbolicLink() && statSync(subPath).isFile() && this.isClaudeFile(subPath)) {
                  files.push(subPath);
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    // Fallback: read all JSONL/JSON/LOG files if no tool-specific files found
    if (files.length === 0) {
      try {
        const entries = safeReadDir(root, dirPath);
        for (const entry of entries) {
          const fullPath = join(dirPath, entry);
          try {
            const stat = statSync(fullPath);
            if (stat.isFile()) {
              const ext = extname(entry).toLowerCase();
              if (ext === '.jsonl' || ext === '.json' || ext === '.log') files.push(fullPath);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    return files;
  }

  private parseFile(filePath: string, result: ImportResult): void {
    try {
      const stat = statSync(filePath);
      if (stat.size === 0) {
        result.skipped++;
        result.errorDetails.push(`Empty file skipped: ${basename(filePath)}`);
        return;
      }

      const ext = extname(filePath).toLowerCase();
      let records: Record<string, unknown>[];

      if (ext === '.jsonl' || ext === '.log') {
        const { records: jsonlRecords, errors } = readJsonl(filePath);
        records = jsonlRecords;
        if (errors.length > 0) {
          result.errorDetails.push(...errors.map((e) => `${basename(filePath)}: ${e}`));
          result.errors += errors.length;
        }
      } else {
        try {
          const content = readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(content);
          records = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          result.errors++;
          result.errorDetails.push(`Failed to parse ${basename(filePath)}: malformed JSON`);
          return;
        }
      }

      const sessionMap = new Map<string, Record<string, unknown>[]>();

      for (const record of records) {
        const sessionId = (record.sessionId as string) || (record.conversationId as string) || (record.id as string);
        if (!sessionId) {
          result.skipped++;
          continue;
        }
        if (!sessionMap.has(sessionId)) sessionMap.set(sessionId, []);
        sessionMap.get(sessionId)!.push(record);
      }

      for (const [sessionId, messages] of sessionMap) {
        const timestamps = messages.map((m) => m.timestamp as string | undefined).filter(Boolean).sort();
        const models = messages.map((m) => m.model as string | undefined).filter(Boolean);
        const cwdPaths = messages.map((m) => m.cwd as string | undefined).filter(Boolean);
        const projectPath = cwdPaths[0];

        result.sessions.push({
          externalId: sessionId,
          sourceToolId: this.toolId,
          projectId: undefined,
          startedAt: timestamps[0],
          endedAt: timestamps.length > 1 ? timestamps[timestamps.length - 1] : undefined,
          summary: this.extractSummary(messages),
          model: models[0],
          metadata: {
            messageCount: messages.length,
            ...(projectPath ? { projectPath } : {}),
          },
          events: messages.map((m) => ({
            eventType: (m.type as string) || 'message',
            occurredAt: m.timestamp as string | undefined,
            summary: typeof m.content === 'string' ? m.content.slice(0, 100) : undefined,
          })),
        });
      }
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errorDetails.push(`Error processing ${basename(filePath)}: ${sanitizeForOutput(msg)}`);
    }
  }

  private extractSummary(messages: Record<string, unknown>[]): string | undefined {
    const models = [...new Set(messages.map((m) => m.model as string | undefined).filter(Boolean))];
    const types = [...new Set(messages.map((m) => m.type as string | undefined).filter(Boolean))];
    const modelStr = models.length > 0 ? models.join(', ') : 'unknown model';
    const typeStr = types.length > 0 ? types.join(', ') : 'assistant';
    return `${messages.length}-message Claude Code session (model: ${modelStr}, types: ${typeStr})`;
  }
}
