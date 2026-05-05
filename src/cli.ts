import { Command } from 'commander';
import { VERSION } from './version.js';
import { handleInit } from './commands/init.js';

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

// Placeholder commands for future milestones
program
  .command('import')
  .description('Import AI coding sessions from local tool data')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .action(() => {
    console.log('Import command will be available in a future release.');
    process.exit(0);
  });

program
  .command('report')
  .description('Generate effectiveness report from imported data')
  .option('-d, --data-dir <path>', 'Custom data directory path')
  .option('--json', 'Output as JSON')
  .action(() => {
    console.log('Report command will be available in a future release.');
    process.exit(0);
  });

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
