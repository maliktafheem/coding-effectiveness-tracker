import { Command } from 'commander';
import { VERSION } from './version.js';
import { handleInit } from './commands/init.js';
import { handleImport } from './commands/import.js';
import { handleReport } from './commands/report.js';
import { handleAnnotate } from './commands/annotate.js';

// Ensure all importers are registered
import './importers/index.js';

const program = new Command();

program
  .name('cet')
  .description(
    'Coding Effectiveness Tracker — a local-first tool to understand whether your AI coding workflows are effective.\n' +
    'All data stays on your machine. No telemetry. No hosted backend.',
  )
  .version(VERSION, '-v, --version', 'Output the current version');

program
  .command('init')
  .description('Initialize a local tracker workspace with configuration and database')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('--force', 'Force reinitialization (overwrites existing database)', false)
  .action(handleInit);

program
  .command('import')
  .description('Import AI coding sessions from local tool data (Codex, OpenCode, Claude Code, Cursor, Factory Droid)')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('-s, --source <path>', 'Explicit source path to import from')
  .option('-t, --tool <id>', 'Tool id to import (codex, opencode, claude-code, cursor, factory-droid)')
  .option('-f, --fixture <path>', 'Import from a fixture JSON file')
  .option('--dry-run', 'Preview import without writing to database', false)
  .option('--discover', 'Scan default AI tool directories for importable data (requires explicit opt-in)')
  .option('--verbose', 'Enable verbose/debug output (privacy-safe: secrets and prompts are redacted)', false)
  .action(handleImport);

program
  .command('report')
  .description('Generate effectiveness report from imported data')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('--json', 'Output as JSON')
  .option('-t, --tool <id>', 'Filter by source tool id')
  .option('-p, --project <id>', 'Filter by project id')
  .option('--from <date>', 'Start date filter (ISO date or datetime)')
  .option('--to <date>', 'End date filter (ISO date or datetime)')
  .action(handleReport);

program
  .command('annotate')
  .description('Record a manual outcome annotation for a session')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('--session <id>', 'Session ID to annotate (required)')
  .option('--outcome <label>', 'Outcome label (good, accepted, shipped, ok, poor, rejected, reverted, etc.)')
  .option('--score <number>', 'Outcome score between 0 and 1')
  .option('--note <text>', 'Free-text note for the annotation')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(handleAnnotate);

program
  .command('serve')
  .description('Start the local dashboard and API server')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('-p, --port <port>', 'Port to listen on', '43187')
  .action(() => {
    console.log('Dashboard server will be available in a future release.');
    process.exit(0);
  });

// Unknown command handler
program.on('command:*', (operands) => {
  const unknown = operands[0];
  console.error(`Unknown command: ${unknown}`);
  console.error('Run "cet --help" to see available commands.');
  process.exit(1);
});

export { program };

// Only run when executed directly
if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  program.parse(process.argv);
}

