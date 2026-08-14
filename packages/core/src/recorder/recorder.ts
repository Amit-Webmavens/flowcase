import type { Browser, BrowserContext, Frame, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import { newId } from '../model/common.js';
import { summarizeStep } from '../model/catalog.js';
import { createStep } from '../model/factory.js';
import type { FrameHop, Target } from '../model/selector.js';
import { ENGINE_BASE_SCORE } from '../model/selector.js';
import type { Step, StepKind } from '../model/step.js';
import type { Environment } from '../model/test.js';
import type { ProjectStore } from '../storage/store.js';
import { absoluteUrl } from '../engine/step-executor.js';
import { installRecorder } from './inject.js';
import type { RecordedEvent, RecordedTarget, RecorderMode } from './protocol.js';

export interface RecorderOptions {
  store: ProjectStore;
  environment?: Environment | undefined;
  /** Where recording starts. Relative paths resolve against the environment base URL. */
  startUrl?: string;
  /** Reuse a saved login so recording can begin behind authentication. */
  session?: string;
  /** Show the in-page toolbar with pause/assert/finish controls. */
  toolbar?: boolean;
  /**
   * Recording is headed by default — the point is to watch a person use the app.
   * Headless is available so the recorder itself can be exercised by tests.
   */
  headless?: boolean;
  onStep?: (step: Step, index: number) => void;
  onNavigate?: (url: string) => void;
  onFinish?: () => void;
}

/**
 * Drives a headed browser and turns what a tester does into steps.
 *
 * The injected script reports raw observations; this class decides what becomes
 * a step. It suppresses navigations that are consequences of a click, resolves
 * the iframe chain for elements inside frames, and streams each new step to the
 * UI as it is captured.
 */
export class RecorderSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly captured: Step[] = [];
  private lastActionAt = 0;
  private stopped = false;
  private mode: RecorderMode = 'record';

  private constructor(private readonly options: RecorderOptions) {}

  static async start(options: RecorderOptions): Promise<RecorderSession> {
    const session = new RecorderSession(options);
    await session.launch();
    return session;
  }

  get steps(): Step[] {
    return this.captured;
  }

  get currentMode(): RecorderMode {
    return this.mode;
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  /** The page being recorded — lets the server show its URL or take a preview shot. */
  get activePage(): Page | undefined {
    return this.page;
  }

  async currentUrl(): Promise<string | undefined> {
    return this.page?.url();
  }

  private async launch(): Promise<void> {
    const { store, environment, session } = this.options;
    const config = await store.getConfig();

    const browserType =
      environment?.browser === 'firefox' ? firefox : environment?.browser === 'webkit' ? webkit : chromium;

    this.browser = await browserType.launch({ headless: this.options.headless ?? false });

    const sessionPath = session ? store.sessionPath(session) : undefined;

    this.context = await this.browser.newContext({
      viewport: environment?.viewport ?? { width: 1280, height: 720 },
      ignoreHTTPSErrors: environment?.ignoreHttpsErrors ?? false,
      ...(environment?.locale === undefined ? {} : { locale: environment.locale }),
      ...(environment && Object.keys(environment.extraHttpHeaders).length > 0
        ? { extraHTTPHeaders: environment.extraHttpHeaders }
        : {}),
      ...(sessionPath === undefined ? {} : { storageState: sessionPath }),
    });

    await this.context.exposeBinding('__flowcaseRecord', async (source, event: RecordedEvent) => {
      await this.handleEvent(event, source.frame);
    });

    await this.context.addInitScript(installRecorder, {
      testIdAttribute: config.testIdAttribute,
      baseScores: ENGINE_BASE_SCORE,
      toolbar: this.options.toolbar ?? true,
    });

    this.page = await this.context.newPage();

    this.page.on('close', () => {
      if (!this.stopped) {
        this.stopped = true;
        this.options.onFinish?.();
      }
    });

    const startUrl = this.options.startUrl?.trim();

    if (startUrl && startUrl.length > 0) {
      const url = absoluteUrl(startUrl, this.options.environment);
      await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      this.push(createStep('goto', { value: url }));
      this.lastActionAt = Date.now();
    }
  }

  /** Flips the in-page mode from the UI (pause / resume). */
  async setMode(mode: RecorderMode): Promise<void> {
    this.mode = mode;

    await this.page
      ?.evaluate((next) => window.__flowcaseSetMode?.(next as RecorderMode), mode)
      .catch(() => undefined);
  }

  async stop(): Promise<Step[]> {
    this.stopped = true;

    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);

    return this.captured;
  }

  private push(step: Step): void {
    step.label = summarizeStep(step);
    this.captured.push(step);
    this.options.onStep?.(step, this.captured.length - 1);
  }

  private async handleEvent(event: RecordedEvent, frame: Frame): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (event.type === 'mode') {
      this.mode = event.mode ?? 'record';
      return;
    }

    if (event.type === 'finish') {
      this.stopped = true;
      this.options.onFinish?.();
      return;
    }

    if (event.type === 'navigate') {
      this.handleNavigation(event);
      return;
    }

    const target = event.target ? this.toTarget(event.target, frame) : undefined;
    const kind = STEP_KIND_BY_EVENT[event.type];

    if (!kind) {
      return;
    }

    const step = createStep(kind, {
      ...(target === undefined ? {} : { target }),
      ...(event.type === 'press'
        ? { value: event.key ?? '' }
        : event.value === undefined
          ? {}
          : { value: event.value }),
      ...(event.type === 'assertText' ? { matcher: 'contains' as const } : {}),
    });

    this.push(step);
    this.lastActionAt = Date.now();
  }

  /**
   * Most navigations follow directly from a click and are already implied by it.
   * A navigation that arrives without a recent action is one the tester made
   * deliberately — typing an address, or using a bookmark — and becomes a step.
   */
  private handleNavigation(event: RecordedEvent): void {
    const url = event.url ?? '';
    this.options.onNavigate?.(url);

    if (Date.now() - this.lastActionAt < 1500) {
      return;
    }

    const previous = this.captured[this.captured.length - 1];

    if (previous?.kind === 'goto' && previous.value === url) {
      return;
    }

    this.push(createStep('goto', { value: url }));
    this.lastActionAt = Date.now();
  }

  private toTarget(recorded: RecordedTarget, frame: Frame): Target {
    return {
      candidates: recorded.candidates.length > 0
        ? recorded.candidates
        : [{ engine: 'css', value: 'body', score: 1, source: 'recorded' }],
      primaryIndex: 0,
      frame: frameChain(frame),
      inShadowDom: recorded.inShadowDom,
      snapshot: recorded.snapshot,
      description: recorded.description,
    };
  }
}

const STEP_KIND_BY_EVENT: Partial<Record<RecordedEvent['type'], StepKind>> = {
  click: 'click',
  dblclick: 'dblclick',
  fill: 'fill',
  select: 'select',
  check: 'check',
  uncheck: 'uncheck',
  press: 'press',
  assertText: 'assertText',
  assertVisible: 'assertVisible',
};

/** Outermost-to-innermost iframe hops for an element captured inside a frame. */
function frameChain(frame: Frame): FrameHop[] {
  const hops: FrameHop[] = [];
  let current: Frame | null = frame;

  while (current && current.parentFrame()) {
    const name = current.name();

    hops.unshift(name ? { kind: 'name', value: name } : { kind: 'url', value: current.url() });
    current = current.parentFrame();
  }

  return hops;
}

/** Builds a fresh, unsaved test from a recording. */
export function stepsToTestDraft(steps: Step[], name: string): { id: string; name: string; steps: Step[] } {
  return { id: newId('t'), name, steps };
}
