import { existsSync, writeFileSync } from 'node:fs';
import { resolveDataDir, isInitialized } from '../config.js';
import { Storage, StorageError } from '../storage.js';
import { generateJsonExport, generateMarkdownExport } from '../api/export.js';

interface ExportOptions {
  dataDir?: string;
  format?: string;
  output?: string;
  overwrite?: boolean;
  tool?: string;
  project?: string;
  from?: string;
  to?: string;
}

export async function handleExport(opts: ExportOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const format = (opts.format || 'json').toLowerCase();
  const output = opts.output;
  if (!isInitialized(dataDir)) {
    console.error('Error: Workspace not initialized. Run "cet init" first.');
    process.exit(1);
  }
  if (!output) {
    console.error('Error: --output <path> is required.');
    console.error('Usage: cet export --format json -o report.json');
    process.exit(1);
  }
  if (format !== 'json' && format !== 'markdown') {
    console.error('Error: Unsupported format. Use json or markdown.');
    process.exit(1);
  }
  if (existsSync(output) && !opts.overwrite) {
    console.error('Error: File already exists: ' + output);
    console.error('Use --overwrite to replace it.');
    process.exit(1);
  }
  let storage: Storage | undefined;
  try {
    storage = Storage.open({ dataDir });
  } catch (err) {
    if (err instanceof StorageError) {
      console.error('Error: ' + err.message);
      process.exit(1);
    }
    throw err;
  }
  try {
    const filterOpts = { toolId: opts.tool, projectId: opts.project, from: opts.from, to: opts.to };
    let content: string;
    if (format === 'json') {
      const data = generateJsonExport(storage, filterOpts);
      content = JSON.stringify(data, null, 2);
    } else {
      content = generateMarkdownExport(storage, filterOpts);
    }
    writeFileSync(output, content, 'utf-8');
    console.log('Exported ' + format +  ' report to: ' + output);
    console.log('Privacy: All data stays local. No telemetry or external services.');
  } finally {
    storage?.close();
  }
}

