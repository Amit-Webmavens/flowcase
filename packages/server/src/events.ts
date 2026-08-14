import type { PrerequisiteProgress, RunEvent, RunSummary, Step } from '@flowcase/core';

/**
 * Recorder progress, streamed so the UI can show steps as they are captured.
 *
 * The `prerequisite:*` events come first when recording starts from a chain of
 * existing tests — that setup can take a while, and a blank screen looks broken.
 */
export type RecorderEvent =
  | { type: 'recorder:started'; startUrl: string | undefined; prerequisiteTestIds: string[] }
  | { type: 'recorder:step'; step: Step; index: number }
  | { type: 'recorder:navigate'; url: string }
  | { type: 'recorder:mode'; mode: 'record' | 'paused' | 'assert' }
  | { type: 'recorder:setupFailed'; message: string }
  | { type: 'recorder:stopped'; steps: Step[] }
  | PrerequisiteProgress;

/** Sent once on connect so a late-joining client can render current state. */
export interface SnapshotEvent {
  type: 'snapshot';
  activeRuns: RunSummary[];
  recording: boolean;
}

export type ServerEvent = RunEvent | RecorderEvent | SnapshotEvent;

/** Fans events out to every connected dashboard. */
export class EventHub {
  private readonly clients = new Set<(event: ServerEvent) => void>();

  add(send: (event: ServerEvent) => void): () => void {
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  broadcast(event: ServerEvent): void {
    for (const send of this.clients) {
      try {
        send(event);
      } catch {
        // A dead socket must not interrupt the run producing these events.
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
