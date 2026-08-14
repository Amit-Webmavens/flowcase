import path from 'node:path';
import pc from 'picocolors';
import { ProjectStore, RecorderSession, createTest, planRun, startRun } from '@flowcase/core';
import { startServer } from '@flowcase/server';
import { uiDistPath } from '@flowcase/ui';
import { ConsoleReporter } from './reporter.js';

async function openStore(cwd: string): Promise<ProjectStore> {
  try {
    return await ProjectStore.open(cwd);
  } catch (error) {
    process.stderr.write(`${pc.red(error instanceof Error ? error.message : String(error))}\n`);
    process.exit(1);
  }
}

export async function initCommand(options: { name?: string; baseUrl?: string; cwd: string }): Promise<void> {
  const existing = await ProjectStore.locate(options.cwd);

  if (existing) {
    process.stdout.write(`${pc.yellow('A flowcase project already exists at')} ${existing}\n`);
    return;
  }

  const store = await ProjectStore.init(options.cwd, {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });

  process.stdout.write(`${pc.green('✓')} Created ${pc.bold(path.relative(options.cwd, store.root) || '.flowcase')}\n\n`);
  process.stdout.write('Next:\n');
  process.stdout.write(`  ${pc.cyan('flowcase ui')}      open the no-code interface\n`);
  process.stdout.write(`  ${pc.cyan('flowcase record')}  record a test from the terminal\n`);
}

export async function uiCommand(options: { port: number; host: string; cwd: string; open: boolean }): Promise<void> {
  const store = await openStore(options.cwd);

  const server = await startServer({
    store,
    port: options.port,
    host: options.host,
    uiDir: uiDistPath,
  });

  process.stdout.write(`\n  ${pc.bold('flowcase')} ${pc.dim('is running')}\n\n`);
  process.stdout.write(`  ${pc.green('➜')}  ${pc.bold(server.url)}\n`);
  process.stdout.write(`  ${pc.dim(`project: ${store.root}`)}\n\n`);
  process.stdout.write(`  ${pc.dim('Press Ctrl+C to stop.')}\n`);

  if (options.open) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [server.url], { stdio: 'ignore', detached: true }).unref();
  }

  const shutdown = async (): Promise<void> => {
    process.stdout.write('\nStopping…\n');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

export async function recordCommand(options: {
  url?: string;
  environment?: string;
  session?: string;
  save?: string;
  cwd: string;
}): Promise<void> {
  const store = await openStore(options.cwd);
  const environment = options.environment
    ? await store.getEnvironment(options.environment)
    : await store.getDefaultEnvironment();

  process.stdout.write(`${pc.dim('Opening a browser. Use your app, then press')} ${pc.bold('Finish')} ${pc.dim('in the toolbar (or close the window).')}\n\n`);

  const session = await RecorderSession.start({
    store,
    environment,
    ...(options.url === undefined ? {} : { startUrl: options.url }),
    ...(options.session === undefined ? {} : { session: options.session }),
    onStep: (step, index) => {
      process.stdout.write(`  ${pc.dim(String(index + 1).padStart(3))} ${step.label}\n`);
    },
  });

  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (!session.isRunning) {
        clearInterval(poll);
        resolve();
      }
    }, 400);

    const stop = (): void => {
      clearInterval(poll);
      resolve();
    };

    process.on('SIGINT', stop);
  });

  const steps = await session.stop();

  if (steps.length === 0) {
    process.stdout.write(`\n${pc.yellow('Nothing was recorded.')}\n`);
    return;
  }

  const name = options.save ?? `Recorded ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const test = await store.saveTest(createTest({ name, steps }));

  process.stdout.write(`\n${pc.green('✓')} Saved ${pc.bold(test.name)} with ${steps.length} steps.\n`);
  process.stdout.write(`  ${pc.dim(`flowcase run ${test.id}`)}\n`);
}

export async function runCommand(options: {
  testIds: string[];
  tags?: string[];
  environment?: string;
  headed: boolean;
  dryRun: boolean;
  concurrency: number;
  approvedOnly: boolean;
  verbose: boolean;
  cwd: string;
}): Promise<void> {
  const store = await openStore(options.cwd);
  const reporter = new ConsoleReporter({ verbose: options.verbose });

  const run = await startRun({
    store,
    testIds: options.testIds,
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.environment === undefined ? {} : { environmentId: options.environment }),
    headed: options.headed,
    dryRun: options.dryRun,
    concurrency: options.concurrency,
    approvedOnly: options.approvedOnly,
    triggeredBy: 'cli',
    onEvent: (event) => reporter.handle(event),
  });

  process.exit(reporter.summary(run));
}

export async function listCommand(options: { cwd: string; tags?: string[] }): Promise<void> {
  const store = await openStore(options.cwd);
  const tests = await store.listTests();

  if (tests.length === 0) {
    process.stdout.write(`${pc.dim('No tests yet. Run')} ${pc.cyan('flowcase record')} ${pc.dim('to make one.')}\n`);
    return;
  }

  const plan = planRun({ tests, ...(options.tags === undefined ? {} : { tags: options.tags }) });
  const byId = new Map(tests.map((test) => [test.id, test]));

  process.stdout.write(`${pc.dim('Execution order:')}\n\n`);

  for (const [index, id] of plan.order.entries()) {
    const test = byId.get(id);

    if (!test) {
      continue;
    }

    const tags = test.tags.length > 0 ? pc.dim(` [${test.tags.join(', ')}]`) : '';
    const status = test.status === 'approved' ? pc.green('✓') : test.status === 'in_review' ? pc.yellow('◷') : pc.dim('·');

    process.stdout.write(`  ${status} ${String(index + 1).padStart(2)}. ${test.name}${tags}\n`);
    process.stdout.write(`       ${pc.dim(test.id)}\n`);
  }

  process.stdout.write(`\n${pc.dim(`${tests.length} tests`)}\n`);
}
