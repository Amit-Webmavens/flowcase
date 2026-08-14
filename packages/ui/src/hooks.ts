import { useCallback, useEffect, useRef, useState } from 'react';
import type { Run, RunSummary, Step } from '@flowcase/core/model';

/** Server-sent events, mirroring the union the server broadcasts. */
export type ServerEvent =
  | { type: 'snapshot'; activeRuns: RunSummary[]; recording: boolean }
  | { type: 'run:start'; runId: string; run: Run }
  | { type: 'run:end'; runId: string; run: Run }
  | { type: 'test:start'; runId: string; testId: string; testName: string; index: number; total: number }
  | { type: 'test:end'; runId: string; testId: string; result: Run['results'][number] }
  | { type: 'step:start'; runId: string; testId: string; step: Run['results'][number]['steps'][number] }
  | { type: 'step:end'; runId: string; testId: string; step: Run['results'][number]['steps'][number] }
  | { type: 'log'; runId: string; testId?: string; entry: { message: string; level: string } }
  | { type: 'recorder:started'; startUrl?: string; prerequisiteTestIds: string[] }
  | { type: 'recorder:step'; step: Step; index: number }
  | { type: 'recorder:navigate'; url: string }
  | { type: 'recorder:mode'; mode: 'record' | 'paused' | 'assert' }
  | { type: 'recorder:setupFailed'; message: string }
  | { type: 'recorder:stopped'; steps: Step[] }
  | { type: 'prerequisite:plan'; order: Array<{ testId: string; name: string }> }
  | { type: 'prerequisite:test'; testId: string; name: string; index: number; total: number }
  | { type: 'prerequisite:step'; testId: string; label: string }
  | { type: 'prerequisite:result'; result: PrerequisiteResult };

/** Mirrors `PrerequisiteResult` in core, which is not importable from the browser build. */
export interface PrerequisiteResult {
  testId: string;
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  stepCount: number;
  error?: string;
  failedStep?: string;
}

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;

/**
 * One shared WebSocket for the whole app, reconnecting on drop. Components
 * subscribe rather than each opening their own connection.
 */
function ensureSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  socket = new WebSocket(url);

  socket.onmessage = (message) => {
    try {
      const event = JSON.parse(String(message.data)) as ServerEvent;
      for (const listener of listeners) {
        listener(event);
      }
    } catch {
      // Ignore malformed frames rather than tearing down the connection.
    }
  };

  socket.onclose = () => {
    socket = undefined;

    if (listeners.size > 0 && reconnectTimer === undefined) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        ensureSocket();
      }, 1500);
    }
  };
}

export function useServerEvents(onEvent: Listener): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const listener: Listener = (event) => handler.current(event);
    listeners.add(listener);
    ensureSocket();

    return () => {
      listeners.delete(listener);
    };
  }, []);
}

export interface AsyncState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** Small data-loading hook: enough for this app, no external state library. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const load = useRef(loader);
  load.current = loader;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    load
      .current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(undefined);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, error, loading, reload };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);

  return `${minutes}m ${seconds}s`;
}

export function formatWhen(iso: string | undefined): string {
  if (!iso) {
    return '—';
  }

  const date = new Date(iso);
  const diff = Date.now() - date.getTime();

  if (diff < 60_000) {
    return 'just now';
  }

  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }

  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }

  return date.toLocaleString();
}
