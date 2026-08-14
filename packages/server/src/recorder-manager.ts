import type { ProjectStore, RecorderMode, Step } from '@flowcase/core';
import { RecorderSession } from '@flowcase/core';
import type { EventHub } from './events.js';

export interface StartRecordingRequest {
  startUrl?: string;
  environmentId?: string;
  session?: string;
  headless?: boolean;
  /** Tests to run first, so recording begins from where they finish. */
  prerequisiteTestIds?: string[];
}

export interface RecorderStatus {
  recording: boolean;
  mode: RecorderMode;
  stepCount: number;
  startUrl?: string;
  currentUrl?: string;
  /**
   * The setup chain this recording started from, after dependency expansion.
   * Saving the recording turns this into the new test's `dependsOn`.
   */
  prerequisiteTestIds: string[];
}

/**
 * Wraps the single active recording session.
 *
 * Only one recorder may run at a time — it drives a real browser window that a
 * person is using, and two would be indistinguishable in the UI.
 */
export class RecorderManager {
  private session: RecorderSession | undefined;
  private startUrl: string | undefined;
  /** Survives `stop()` so the review screen can still offer to chain the new test. */
  private prerequisiteTestIds: string[] = [];

  constructor(
    private readonly store: ProjectStore,
    private readonly hub: EventHub,
  ) {}

  get isRecording(): boolean {
    return this.session?.isRunning ?? false;
  }

  async start(request: StartRecordingRequest): Promise<RecorderStatus> {
    if (this.isRecording) {
      throw new Error('A recording is already in progress. Stop it before starting another.');
    }

    const environment = request.environmentId
      ? await this.store.getEnvironment(request.environmentId)
      : await this.store.getDefaultEnvironment();

    this.startUrl = request.startUrl;
    this.prerequisiteTestIds = [];

    try {
      this.session = await RecorderSession.start({
        store: this.store,
        environment,
        ...(request.startUrl === undefined ? {} : { startUrl: request.startUrl }),
        ...(request.session === undefined ? {} : { session: request.session }),
        ...(request.headless === undefined ? {} : { headless: request.headless }),
        ...(request.prerequisiteTestIds === undefined
          ? {}
          : { prerequisiteTestIds: request.prerequisiteTestIds }),
        onPrerequisite: (event) => this.hub.broadcast(event),
        onStep: (step, index) => this.hub.broadcast({ type: 'recorder:step', step, index }),
        onNavigate: (url) => this.hub.broadcast({ type: 'recorder:navigate', url }),
        onFinish: () => {
          // The tester pressed Finish in the page toolbar, or closed the window.
          void this.stop();
        },
      });
    } catch (error) {
      // The chain failed, so no browser is waiting. Tell every dashboard, not
      // just the tab that issued the request.
      const message = error instanceof Error ? error.message : String(error);
      this.hub.broadcast({ type: 'recorder:setupFailed', message });
      throw error;
    }

    this.prerequisiteTestIds = this.session.prerequisiteTestIds;

    this.hub.broadcast({
      type: 'recorder:started',
      startUrl: request.startUrl,
      prerequisiteTestIds: this.prerequisiteTestIds,
    });

    return this.status();
  }

  async setMode(mode: RecorderMode): Promise<RecorderStatus> {
    await this.session?.setMode(mode);
    this.hub.broadcast({ type: 'recorder:mode', mode });

    return this.status();
  }

  /** Ends the session and returns everything captured. */
  async stop(): Promise<Step[]> {
    if (!this.session) {
      return [];
    }

    const session = this.session;
    this.session = undefined;

    const steps = await session.stop();
    this.hub.broadcast({ type: 'recorder:stopped', steps });

    return steps;
  }

  get steps(): Step[] {
    return this.session?.steps ?? [];
  }

  status(): RecorderStatus {
    return {
      recording: this.isRecording,
      mode: this.session?.currentMode ?? 'record',
      stepCount: this.session?.steps.length ?? 0,
      prerequisiteTestIds: this.prerequisiteTestIds,
      ...(this.startUrl === undefined ? {} : { startUrl: this.startUrl }),
    };
  }
}
