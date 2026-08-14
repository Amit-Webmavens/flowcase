import type { JsonValue, ProjectStore, Run, RunSummary } from '@flowcase/core';
import { startRun, summarizeRun } from '@flowcase/core';
import type { EventHub } from './events.js';

export interface StartRunRequest {
  testIds?: string[];
  tags?: string[];
  environmentId?: string;
  variables?: Record<string, JsonValue>;
  dryRun?: boolean;
  /** Omit to let the environment profile decide whether the browser is shown. */
  headed?: boolean;
  slowMo?: number;
  concurrency?: number;
  approvedOnly?: boolean;
  triggeredByUser?: string;
}

interface ActiveRun {
  summary: RunSummary;
  controller: AbortController;
  finished: Promise<Run>;
}

/**
 * Owns in-flight runs.
 *
 * Runs execute in the background; the HTTP call returns as soon as the run has
 * an id, and progress reaches the UI over the WebSocket. That keeps a long suite
 * from holding a request open, and lets several runs be observed at once.
 */
export class RunManager {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly store: ProjectStore,
    private readonly hub: EventHub,
  ) {}

  /** Starts a run and resolves once it has an id — not when it finishes. */
  async start(request: StartRunRequest): Promise<string> {
    const controller = new AbortController();

    let resolveId: (id: string) => void = () => undefined;
    const idReady = new Promise<string>((resolve) => {
      resolveId = resolve;
    });

    const finished = startRun({
      store: this.store,
      ...(request.testIds === undefined ? {} : { testIds: request.testIds }),
      ...(request.tags === undefined ? {} : { tags: request.tags }),
      ...(request.environmentId === undefined ? {} : { environmentId: request.environmentId }),
      ...(request.variables === undefined ? {} : { variables: request.variables }),
      ...(request.dryRun === undefined ? {} : { dryRun: request.dryRun }),
      ...(request.headed === undefined ? {} : { headed: request.headed }),
      ...(request.slowMo === undefined ? {} : { slowMo: request.slowMo }),
      ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
      ...(request.approvedOnly === undefined ? {} : { approvedOnly: request.approvedOnly }),
      ...(request.triggeredByUser === undefined ? {} : { triggeredByUser: request.triggeredByUser }),
      triggeredBy: 'ui',
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'run:start') {
          this.active.set(event.runId, {
            summary: summarizeRun(event.run),
            controller,
            finished,
          });
          resolveId(event.runId);
        }

        if (event.type === 'run:end') {
          this.active.delete(event.runId);
        }

        this.hub.broadcast(event);
      },
    });

    finished.catch(() => undefined).finally(() => {
      for (const [id, entry] of this.active) {
        if (entry.controller === controller) {
          this.active.delete(id);
        }
      }
    });

    // If the run fails before emitting run:start, don't hang the request.
    return Promise.race([
      idReady,
      finished.then((run) => run.id),
    ]);
  }

  abort(runId: string): boolean {
    const entry = this.active.get(runId);

    if (!entry) {
      return false;
    }

    entry.controller.abort(new Error('Run cancelled from the dashboard.'));
    return true;
  }

  abortAll(): void {
    for (const runId of [...this.active.keys()]) {
      this.abort(runId);
    }
  }

  get activeRuns(): RunSummary[] {
    return [...this.active.values()].map((entry) => entry.summary);
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }
}
