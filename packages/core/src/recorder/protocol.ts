import type { ElementSnapshot, SelectorCandidate } from '../model/selector.js';

/** Everything the injected script needs. Passed as the init-script argument. */
export interface InjectConfig {
  testIdAttribute: string;
  baseScores: Record<string, number>;
  toolbar: boolean;
  /** Ripple where the tester clicks, confirming the action was captured. */
  highlight: boolean;
}

export interface RecordedTarget {
  candidates: SelectorCandidate[];
  snapshot: ElementSnapshot;
  description: string;
  inShadowDom: boolean;
}

export type RecorderMode = 'record' | 'paused' | 'assert';

/** A single observation sent from the page to the Node-side recorder. */
export interface RecordedEvent {
  type:
    | 'click'
    | 'dblclick'
    | 'fill'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'press'
    | 'navigate'
    | 'assertText'
    | 'assertVisible'
    | 'mode'
    | 'finish';
  target?: RecordedTarget;
  value?: string;
  key?: string;
  url?: string;
  mode?: RecorderMode;
  at: number;
}

declare global {
  interface Window {
    /** Installed by Playwright's `exposeBinding`. */
    __flowcaseRecord?: (event: RecordedEvent) => Promise<void>;
    /** Guards against the init script installing itself twice in one frame. */
    __flowcaseInstalled?: boolean;
    /** Lets the Node side flip modes without re-injecting. */
    __flowcaseSetMode?: (mode: RecorderMode) => void;
  }
}
