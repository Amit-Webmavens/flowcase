import type { LogEntry, Run, StepResult, TestResult } from '../model/run.js';

/**
 * Everything the runner reports as it works. The server forwards these verbatim
 * over the WebSocket, so the dashboard can show step-by-step progress — including
 * several tests running at once — without polling.
 */
export type RunEvent =
  | { type: 'run:start'; runId: string; run: Run }
  | { type: 'run:end'; runId: string; run: Run }
  | { type: 'test:start'; runId: string; testId: string; testName: string; index: number; total: number }
  | { type: 'test:end'; runId: string; testId: string; result: TestResult }
  | { type: 'step:start'; runId: string; testId: string; step: StepResult }
  | { type: 'step:end'; runId: string; testId: string; step: StepResult }
  | { type: 'log'; runId: string; testId?: string; entry: LogEntry };

export type RunEventHandler = (event: RunEvent) => void;

/** Fan-out helper that never lets a listener error break a run. */
export class EventBus {
  private readonly handlers = new Set<RunEventHandler>();

  subscribe(handler: RunEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: RunEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // A broken subscriber must never fail the run it is observing.
      }
    }
  }
}
