/**
 * Cursor local filesystem importer.
 *
 * Cursor stores session data in %APPDATA%/Cursor or ~/.cursor on Windows/macOS/Linux.
 * Expected structure: JSON files with conversation/session entries.
 *
 * Each record typically has fields like:
 * - id, sessionId, role, content, model, timestamp, tokens, etc.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { ToolImporter, ImportOptions, ImportResult } from './types.js';
import { readJsonl } from './utils.js';
import { sanitizeForOutput } from './privacy.js';

export class CursorImporter implements ToolImporter {
  readonly toolId = 'cursor';
  readonly displayName = 'Cursor';

  canHandle(sourcePath: string): boolean {
    try {
      if (!existsSync(sourcePath)) return false;
      const stat = statSync(sourcePath);
      if (stat.isFile()) {
        return this.isCursorFile(sourcePath);
      }
      const dirName = basename(sourcePath).toLowerCase();
      if (dirName === 'cursor' || dirName === '.cursor') return true;
      return this.hasCursorFiles(sourcePath);
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
      const files = stat.isFile() ? [sourcePath] : this.findSessionFiles(sourcePath);

      for (const file of files) {
        this.parseFile(file, result);
      }
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errorDetails.push(`Cursor parse error: ${sanitizeForOutput(msg)}`);
    }

    result.imported = result.sessions.length;
    return result;
  }

  private isCursorFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    if (ext !== '.json' && ext !== '.jsonl') return false;
    const name = basename(filePath).toLowerCase();
    return name.includes('conversation') || name.includes('cursor') || name.includes('chat');
  }

  private hasCursorFiles(dirPath: string): boolean {
    try {
      const entries = readdirSync(dirPath);
      return entries.some((e) => this.isCursorFile(join(dirPath, e)));
    } catch {
      return false;
    }
  }

  private findSessionFiles(dirPath: string): string[] {
    const files: string[] = [];
    try {
      const entries = readdirSync(dirPath);
      for (const entry of entries) {
        const fullPath = join(dirPath, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile() && this.isCursorFile(fullPath)) {
            files.push(fullPath);
          } else if (stat.isDirectory() && !entry.startsWith('.')) {
            const subEntries = readdirSync(fullPath);
            for (const sub of subEntries) {
              const subPath = join(fullPath, sub);
              try {
                if (statSync(subPath).isFile() && this.isCursorFile(subPath)) {
                  files.push(subPath);
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    // Fallback: read all JSONL/JSON files if no tool-specific files found
    if (files.length === 0) {
      try {
        const entries = readdirSync(dirPath);
        for (const entry of entries) {
          const fullPath = join(dirPath, entry);
          try {
            const stat = statSync(fullPath);
            if (stat.isFile()) {
              const ext = extname(entry).toLowerCase();
              if (ext === '.jsonl' || ext === '.json') files.push(fullPath);
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

      if (ext === '.jsonl') {
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
        const sessionId = (record.sessionId as string) || (record.session_id as string) || (record.id as string);
        if (!sessionId) {
          result.skipped++;
          continue;
        }
        if (!sessionMap.has(sessionId)) sessionMap.set(sessionId, []);
        sessionMap.get(sessionId)!.push(record);
      }

      for (const [sessionId, messages] of sessionMap) {
        const timestamps = messages.map((m) => (m.timestamp as string) || (m.created_at as string) || undefined).filter(Boolean).sort();
        const models = messages.map((m) => m.model as string | undefined).filter(Boolean);
        const tokenInputs = messages.reduce((sum, m) => sum + ((m.tokens_input as number) || (m.input_tokens as number) || 0), 0);
        const tokenOutputs = messages.reduce((sum, m) => sum + ((m.tokens_output as number) || (m.output_tokens as number) || 0), 0);

        result.sessions.push({
          externalId: sessionId,
          sourceToolId: this.toolId,
          startedAt: timestamps[0],
          endedAt: timestamps.length > 1 ? timestamps[timestamps.length - 1] : undefined,
          summary: this.extractSummary(messages),
          model: models[0],
          tokensInput: tokenInputs > 0 ? tokenInputs : undefined,
          tokensOutput: tokenOutputs > 0 ? tokenOutputs : undefined,
          metadata: { messageCount: messages.length },
          events: messages.map((m) => ({
            eventType: (m.role as string) || (m.type as string) || 'message',
            occurredAt: (m.timestamp as string) || (m.created_at as string) || undefined,
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
    for (const msg of messages) {
      if (msg.role === 'user') {
        const content = msg.content || msg.message;
        if (typeof content === 'string' && content.length > 0) return content.slice(0, 200);
      }
    }
    return `${messages.length} messages in Cursor session`;
  }
}
