import type { ProjectStore } from '@flowcase/core';
import { Scheduler } from '@flowcase/core';
import { buildServer } from './app.js';
import type { FlowcaseServer } from './app.js';

export * from './app.js';
export * from './events.js';
export * from './run-manager.js';
export * from './recorder-manager.js';

export interface StartServerOptions {
  store: ProjectStore;
  host?: string;
  port?: number;
  uiDir?: string;
  logger?: boolean;
  /** Run scheduled suites while the server is up. On by default. */
  schedules?: boolean;
}

export interface RunningServer extends FlowcaseServer {
  url: string;
  scheduler: Scheduler | undefined;
  close: () => Promise<void>;
}

/**
 * Boots the control plane. Any run left in flight by a previous process is
 * reconciled first, so the dashboard never shows a run that stopped existing
 * when the process did.
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const reconciled = await options.store.reconcileActiveRuns();

  const server = await buildServer({
    store: options.store,
    ...(options.uiDir === undefined ? {} : { uiDir: options.uiDir }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4100;

  await server.app.listen({ host, port });

  if (reconciled.length > 0) {
    server.app.log.warn(`Marked ${reconciled.length} interrupted run(s) as aborted.`);
  }

  const url = `http://${host}:${port}`;
  let scheduler: Scheduler | undefined;

  if (options.schedules ?? true) {
    scheduler = new Scheduler(options.store, {
      baseUrl: url,
      onEvent: (event) => server.hub.broadcast(event),
      onError: (schedule, error) =>
        server.app.log.error(`Schedule "${schedule.name}" failed: ${error.message}`),
    });

    scheduler.start();
  }

  return {
    ...server,
    url,
    scheduler,
    close: async () => {
      scheduler?.stop();
      server.runs.abortAll();
      await server.recorder.stop().catch(() => undefined);
      await server.app.close();
    },
  };
}
