import { Command } from 'commander';
import { VERSION } from './version.js';
import { handleSetup } from './commands/setup.js';
import { handleInit } from './commands/init.js';
import { handleImport } from './commands/import.js';
import { handleReport } from './commands/report.js';
import { handleAnnotate } from './commands/annotate.js';
import { handleSync } from './commands/sync.js';
import { handleTestOutcome } from './commands/test-outcome.js';
import { handleCompare } from './commands/compare.js';
import { handleServe } from './commands/serve.js';
import { handleExport } from './commands/export.js';
import { handleWatch } from './commands/watch.js';
import { handleTag } from './commands/tag.js';
import { handleDiff } from './commands/diff.js';
import { handlePromptQuality } from './commands/prompt-quality.js';

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
  .command('setup')
  .description('One-command onboarding: initialize, discover AI tools, sync git, and start the dashboard')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('--port <port>', 'Dashboard port (default: 43187)')
  .option('--no-serve', 'Skip starting the dashboard server')
  .option('--interactive', 'Ask which tools to import and which repo to sync')
  .action(handleSetup);

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
  .option('--enable-plugins', 'Load user plugins from data dir (arbitrary code execution)')
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
  .command('tag')
  .description('Tag sessions with labels for filtering and organization')
  .requiredOption('--session <id>', 'Session ID to tag')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--remove', 'Remove the specified tags instead of adding')
  .option('--list', 'List current tags on the session')
  .action(handleTag);

program
  .command('sync')
  .description('Sync local Git repository commits and correlate with imported sessions (local-only, no remote calls)')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('-r, --repo <path>', 'Path to local Git repository (required)')
  .option('-p, --project <id>', 'Project ID (defaults to repo directory name)')
  .option('--pr', 'Also fetch GitHub PR outcomes (requires gh CLI authed)')
  .action(handleSync);

program
  .command('diff <session-id>')
  .description('Show git diff of commits linked to a session')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('-r, --repo <path>', 'Repo path (defaults to session metadata projectPath)')
  .option('--commit <hash>', 'Filter to single commit by hash/shortHash prefix')
  .option('--stats', 'Stats only (no diff text)')
  .option('--files', 'List changed files only')
  .option('--no-cache', 'Bypass cache and live-fetch from git')
  .action(handleDiff);

program
  .command('prompt-quality')
  .description('Score prompt quality for sessions using heuristic analysis')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('--session <id>', 'Show detail for a single session')
  .option('--recompute', 'Force recompute all (ignore cache)')
  .option('--top <n>', 'Show top N best prompts')
  .option('--worst <n>', 'Show worst N prompts')
  .option('--analyzer <id>', 'Analyzer id (default: heuristic-v1)')
  .action(handlePromptQuality);

program
  .command('test')
  .description('Run a command and record the test outcome for effectiveness tracking')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('-p, --project <id>', 'Project ID (defaults to derived from cwd)')
  .allowUnknownOption()

program
  .command('compare')
  .description('Compare effectiveness between time periods, projects, or tools')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('-p, --project <id>', 'Filter by project id')
  .option('-t, --tool <id>', 'Filter by tool id')
  .option('--period <mode>', 'Compare by "tools", "projects", or default time periods')
  .option('--from1 <date>', 'Period 1 start date')
  .option('--to1 <date>', 'Period 1 end date')
  .option('--from2 <date>', 'Period 2 start date')
  .option('--to2 <date>', 'Period 2 end date')
  .action(handleCompare);

program
  .command('test-outcome')
  .description('Ingest local test result artifacts or command outcome records and correlate with sessions (local-only)')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('-p, --project <id>', 'Project ID (default: "default")')
  .option('--outcome-json <path>', 'JSON file with array of test outcome records')
  .option('--command <str>', 'Test command name')
  .option('--passed <n>', 'Number of passed tests')
  .option('--failed <n>', 'Number of failed tests')
  .option('--skipped <n>', 'Number of skipped tests')
  .option('--duration <ms>', 'Duration in milliseconds')
  .option('--run-at <datetime>', 'ISO datetime of the test run (default: now)')
  .option('--session <id>', 'Session ID to link outcome to')
  .option('--commit <hash>', 'Commit hash to link outcome to')
  .action(handleTestOutcome);

program
  .command('serve')
  .description('Start the local dashboard and API server (loopback only, 127.0.0.1)')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('-p, --port <port>', 'Port to listen on', '43187')
  .action(handleServe);

program
  .command('export')
  .description('Export effectiveness report to a local file')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('-f, --format <fmt>', 'Export format (json or markdown)', 'json')
  .option('-o, --output <path>', 'Output file path (required)')
  .option('--overwrite', 'Overwrite existing file', false)
  .option('-t, --tool <id>', 'Filter by source tool id')
  .option('-p, --project <id>', 'Filter by project id')
  .option('--from <date>', 'Start date filter')
  .option('--to <date>', 'End date filter')
  .action(handleExport);

program
  .command('watch')
  .description('Start/stop/status a background daemon that keeps tracker data fresh (imports sessions, syncs git)')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('--stop', 'Stop the running daemon')
  .option('--status', 'Check daemon status')
  .option('--interval <minutes>', 'Polling interval in minutes (default: 10, min: 1)')
  .action(handleWatch);

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
  // Check for zero-arg BEFORE parse since Commander auto-exits with help when no command is given
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length === 0) {
    console.log('');
    console.log('Coding Effectiveness Tracker');
    console.log('───────────────────────────');
    console.log('Track and understand your AI coding effectiveness in 3 seconds:');
    console.log('');
    console.log('  cet setup');
    console.log('');
    console.log('Or import sessions from a specific tool:');
    console.log('  cet import --tool claude-code --discover');
    console.log('  cet import --tool opencode --discover');
    console.log('  cet import --tool codex --discover');
    console.log('');
    console.log('Capture test outcomes:');
    console.log('  cet test -- <command>');
    console.log('');
    console.log('Need more control?');
    console.log('  cet setup --help     See all setup options');
    console.log('  cet --help            See all commands');
    console.log('  cet import --help     Learn about importing from specific tools');
    console.log('  cet watch --help      Learn about background monitoring');
    console.log('');
    console.log('Docs: https://github.com/maliktafheem/coding-effectiveness-tracker');
    console.log('All data stays local. No telemetry.');
    console.log('');
    process.exit(0);
  }

  // Intercept `cet test -- <command>` before Commander parse
  // Commander's -- passthrough doesn't handle subcommand args well
  if (cliArgs[0] === 'test') {
    const sepIndex = cliArgs.indexOf('--');
    const cmdArgs: string[] = [];
    if (sepIndex >= 0) {
      cmdArgs.push(...cliArgs.slice(sepIndex + 1));
    }
    // Handle -- help and options before --
    const preSep = sepIndex >= 0 ? cliArgs.slice(1, sepIndex) : cliArgs.slice(1);
    const dataDirIdx = preSep.indexOf('-d');
    const dataDirLongIdx = preSep.indexOf('--data-dir');
    const projectIdx = preSep.indexOf('-p');
    const projectLongIdx = preSep.indexOf('--project');
    const dataDir = dataDirIdx >= 0 ? preSep[dataDirIdx + 1] : (dataDirLongIdx >= 0 ? preSep[dataDirLongIdx + 1] : undefined);
    const project = projectIdx >= 0 ? preSep[projectIdx + 1] : (projectLongIdx >= 0 ? preSep[projectLongIdx + 1] : undefined);

    if (preSep.includes('--help') || preSep.includes('-h')) {
      // Show test help
      console.log('Usage: cet test [options] -- <command>');
      console.log('');
      console.log('Run a command and record the test outcome for effectiveness tracking.');
      console.log('The command output is streamed to the terminal and the exit code is recorded.');
      console.log('');
      console.log('Options:');
      console.log('  -d, --data-dir <path>  Custom data directory path');
      console.log('  -p, --project <id>     Project ID (defaults to derived from cwd)');
      console.log('');
      console.log('Examples:');
      console.log('  cet test -- npm test');
      console.log('  cet test -- pytest tests/');
      console.log('  cet test -- node -e "process.exit(0)"');
      process.exit(0);
    }

    import('./commands/test.js').then(({ handleTest }) =>
      handleTest({ dataDir, project, args: cmdArgs })
    );
  } else {
    program.parse(process.argv);
  }
}

