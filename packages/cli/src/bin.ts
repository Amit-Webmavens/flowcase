#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { initCommand, listCommand, recordCommand, runCommand, uiCommand } from './commands.js';

const program = new Command();

program
  .name('flowcase')
  .description('No-code, React-based end-to-end test runner built on Playwright.')
  .version('0.1.0');

program
  .command('init')
  .description('Create a flowcase project in the current directory')
  .option('-n, --name <name>', 'project name')
  .option('-u, --base-url <url>', 'base URL of the app under test')
  .action(async (options: { name?: string; baseUrl?: string }) => {
    await initCommand({ ...options, cwd: process.cwd() });
  });

program
  .command('ui')
  .description('Open the no-code interface')
  .option('-p, --port <port>', 'port to listen on', '4100')
  .option('-H, --host <host>', 'host to bind', '127.0.0.1')
  .option('--open', 'open a browser window', false)
  .action(async (options: { port: string; host: string; open: boolean }) => {
    await uiCommand({
      port: Number(options.port),
      host: options.host,
      open: options.open,
      cwd: process.cwd(),
    });
  });

program
  .command('record')
  .description('Record a test by using your app in a real browser')
  .option('-u, --url <url>', 'where to start')
  .option('-e, --env <id>', 'environment to record against')
  .option('-s, --session <name>', 'start from a saved login session')
  .option('--save <name>', 'name for the saved test')
  .action(async (options: { url?: string; env?: string; session?: string; save?: string }) => {
    await recordCommand({
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.env === undefined ? {} : { environment: options.env }),
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.save === undefined ? {} : { save: options.save }),
      cwd: process.cwd(),
    });
  });

program
  .command('run')
  .description('Run tests and exit non-zero if any fail')
  .argument('[tests...]', 'test ids to run; omit to run everything')
  .option('-t, --tag <tag...>', 'only tests with these tags (prefix with ! to exclude)')
  .option('-e, --env <id>', 'environment to run against')
  .option('--headed', 'show the browser', false)
  .option('--dry-run', 'resolve everything and report what would run, without a browser', false)
  .option('-c, --concurrency <n>', 'independent tests to run at once', '1')
  .option('--approved-only', 'skip tests that have not been approved', false)
  .option('-v, --verbose', 'print every step, not just failures', false)
  .action(
    async (
      tests: string[],
      options: {
        tag?: string[];
        env?: string;
        headed: boolean;
        dryRun: boolean;
        concurrency: string;
        approvedOnly: boolean;
        verbose: boolean;
      },
    ) => {
      await runCommand({
        testIds: tests,
        ...(options.tag === undefined ? {} : { tags: options.tag }),
        ...(options.env === undefined ? {} : { environment: options.env }),
        headed: options.headed,
        dryRun: options.dryRun,
        concurrency: Number(options.concurrency),
        approvedOnly: options.approvedOnly,
        verbose: options.verbose,
        cwd: process.cwd(),
      });
    },
  );

program
  .command('list')
  .description('List tests in the order they would run')
  .option('-t, --tag <tag...>', 'filter by tag')
  .action(async (options: { tag?: string[] }) => {
    await listCommand({
      cwd: process.cwd(),
      ...(options.tag === undefined ? {} : { tags: options.tag }),
    });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${pc.red(error instanceof Error ? error.message : String(error))}\n`);
  process.exit(1);
});
