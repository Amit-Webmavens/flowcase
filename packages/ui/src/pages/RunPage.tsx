import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Run, StepResult, TestResult } from '@flowcase/core/model';
import { api, artifactUrl } from '../api.js';
import { formatDuration, formatWhen, useServerEvents } from '../hooks.js';
import { Badge, Button, Card, ErrorNote, Loading, StatusIcon, statusTone } from '../ui.js';

/**
 * Live run view. Steps stream in over the WebSocket as they execute, and the
 * full record is re-fetched when the run ends so artifacts resolve.
 */
export function RunPage() {
  const { id = '' } = useParams();
  const [run, setRun] = useState<Run & { active?: boolean }>();
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api
      .getRun(id)
      .then(setRun)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [id]);

  useEffect(reload, [reload]);

  useServerEvents((event) => {
    if (!('runId' in event) || event.runId !== id) {
      return;
    }

    if (event.type === 'run:end') {
      setRun(event.run);
      // Artifacts are written as the run finishes; refetch so links resolve.
      setTimeout(reload, 300);
      return;
    }

    if (event.type === 'step:end' || event.type === 'step:start') {
      setRun((current) => (current ? applyStep(current, event.testId, event.step) : current));
      return;
    }

    if (event.type === 'test:end') {
      setRun((current) => (current ? applyTestResult(current, event.result) : current));
    }
  });

  if (error) {
    return <ErrorNote>{error}</ErrorNote>;
  }

  if (!run) {
    return <Loading label="Loading run…" />;
  }

  const running = run.status === 'running' || run.status === 'queued';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/runs" className="text-sm text-muted hover:text-ink">
          ← Runs
        </Link>

        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
        {run.dryRun && <Badge tone="purple">preview only</Badge>}

        <span className="text-sm text-muted">
          {run.results.length} test{run.results.length === 1 ? '' : 's'} · {formatDuration(run.durationMs)} ·{' '}
          {formatWhen(run.startedAt)}
        </span>

        {run.environmentName && <Badge>{run.environmentName}</Badge>}

        {running && (
          <Button variant="danger" size="sm" className="ml-auto" onClick={() => api.abortRun(run.id)}>
            Stop run
          </Button>
        )}
      </div>

      {run.error && <ErrorNote>{run.error}</ErrorNote>}

      {Object.keys(run.variables).length > 0 && (
        <Card className="p-3">
          <p className="mb-1 text-xs font-medium text-muted">Values captured during this run</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(run.variables).map(([name, value]) => (
              <code key={name} className="rounded bg-canvas px-1.5 py-0.5 text-xs">
                {name} = {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </code>
            ))}
          </div>
        </Card>
      )}

      {run.results.map((result, index) => (
        <TestResultCard key={`${result.testId}-${result.dataRowIndex ?? index}`} runId={run.id} result={result} />
      ))}

      {run.results.length === 0 && running && <Loading label="Starting…" />}
    </div>
  );
}

function TestResultCard({ runId, result }: { runId: string; result: TestResult }) {
  const [open, setOpen] = useState(result.status !== 'passed');

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left"
      >
        <StatusIcon status={result.status} />
        <span className="font-medium">{result.testName}</span>
        {result.dataRowLabel && <Badge tone="purple">{result.dataRowLabel}</Badge>}
        <Badge tone={statusTone(result.status)}>{result.status}</Badge>
        <span className="text-xs text-muted">{formatDuration(result.durationMs)}</span>
        {result.softFailures.length > 0 && <Badge tone="amber">{result.softFailures.length} soft</Badge>}
        <span className="ml-auto text-xs text-muted">{open ? '▲' : '▼'}</span>
      </button>

      {result.skipReason && <p className="px-4 pb-2 text-xs text-muted">{result.skipReason}</p>}

      {open && (
        <div className="border-t border-line">
          {result.artifacts.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2">
              {result.artifacts.map((artifact) => (
                <a
                  key={artifact.path}
                  href={artifactUrl(runId, artifact.path)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-line px-2 py-1 text-xs hover:border-brand hover:text-brand"
                >
                  {artifactLabel(artifact.kind)} {artifact.label ? `— ${artifact.label}` : ''}
                </a>
              ))}
            </div>
          )}

          {result.artifacts
            .filter((artifact) => artifact.kind === 'video')
            .map((artifact) => (
              <video
                key={artifact.path}
                controls
                src={artifactUrl(runId, artifact.path)}
                className="max-h-96 w-full bg-black"
              />
            ))}

          <ol className="divide-y divide-line/60">
            {result.steps.map((step, index) => (
              <StepRow key={`${step.stepId}-${index}`} runId={runId} step={step} />
            ))}
          </ol>

          {result.softFailures.length > 0 && (
            <div className="border-t border-line px-4 py-2">
              <p className="mb-1 text-xs font-medium text-amber-600 dark:text-amber-400">Soft assertion failures</p>
              <ul className="list-disc pl-5 text-xs text-muted">
                {result.softFailures.map((failure, index) => (
                  <li key={index}>
                    <span className="font-medium">{failure.label}</span> — {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function StepRow({ runId, step }: { runId: string; step: StepResult }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(step.error) || step.artifacts.length > 0 || Object.keys(step.extracted).length > 0;

  return (
    <li>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm"
        style={{ paddingLeft: 16 + step.depth * 16 }}
      >
        <StatusIcon status={step.status} />
        <span className={step.status === 'skipped' ? 'text-muted' : ''}>{step.label}</span>

        {step.iteration !== undefined && <Badge>#{step.iteration + 1}</Badge>}
        {step.healed && <Badge tone="purple">selector healed</Badge>}
        {step.attempts > 1 && <Badge tone="amber">{step.attempts} attempts</Badge>}
        {Object.keys(step.extracted).length > 0 && <Badge tone="green">captured</Badge>}

        <span className="ml-auto text-xs text-muted">{step.durationMs > 0 ? formatDuration(step.durationMs) : ''}</span>
      </button>

      {open && (
        <div className="bg-canvas/60 px-4 py-2" style={{ paddingLeft: 32 + step.depth * 16 }}>
          {step.error && (
            <pre className="scroll-x mb-2 rounded bg-red-500/10 p-2 text-xs whitespace-pre-wrap text-red-700 dark:text-red-300">
              {step.error.message}
            </pre>
          )}

          {step.healed && (
            <p className="mb-2 text-xs text-purple-600 dark:text-purple-400">
              The recorded selector <code>{step.healed.from}</code> stopped matching. flowcase used{' '}
              <code>{step.healed.to}</code> instead, with {(step.healed.confidence * 100).toFixed(0)}% confidence
              it is the same element.
            </p>
          )}

          {step.usedSelector && <p className="mb-2 font-mono text-[11px] text-muted">{step.usedSelector}</p>}

          {Object.keys(step.extracted).length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {Object.entries(step.extracted).map(([name, value]) => (
                <code key={name} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs">
                  {name} = {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </code>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {step.artifacts.map((artifact) => (
              <a key={artifact.path} href={artifactUrl(runId, artifact.path)} target="_blank" rel="noreferrer">
                {artifact.contentType?.startsWith('image/') ? (
                  <img
                    src={artifactUrl(runId, artifact.path)}
                    alt={artifact.label ?? artifact.kind}
                    className="max-h-64 rounded border border-line"
                  />
                ) : (
                  <span className="rounded border border-line px-2 py-1 text-xs">{artifactLabel(artifact.kind)}</span>
                )}
              </a>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

function artifactLabel(kind: string): string {
  const labels: Record<string, string> = {
    screenshot: '📷 Screenshot',
    video: '🎬 Video',
    trace: '🧭 Trace',
    console: '📋 Logs',
    network: '🌐 Network',
    diff: '🔍 Visual diff',
    baseline: '🖼 Baseline',
    actual: '🖼 This run',
    html: '📄 HTML',
  };

  return labels[kind] ?? kind;
}

/** Applies a streamed step into the run currently on screen. */
function applyStep(run: Run, testId: string, step: StepResult): Run {
  const results = run.results.map((result) => {
    if (result.testId !== testId) {
      return result;
    }

    const steps = [...result.steps];
    const existing = steps.findIndex((entry) => entry.index === step.index);

    if (existing >= 0) {
      steps[existing] = step;
    } else {
      steps.push(step);
    }

    return { ...result, steps };
  });

  // A test that has not reported yet needs a placeholder row to attach steps to.
  if (!results.some((result) => result.testId === testId)) {
    results.push({
      testId,
      testName: testId,
      testVersion: 0,
      status: 'running',
      durationMs: 0,
      steps: [step],
      artifacts: [],
      variables: {},
      softFailures: [],
    });
  }

  return { ...run, results };
}

function applyTestResult(run: Run, result: TestResult): Run {
  const index = run.results.findIndex(
    (entry) => entry.testId === result.testId && entry.dataRowIndex === result.dataRowIndex,
  );

  const results = [...run.results];

  if (index >= 0) {
    results[index] = result;
  } else {
    results.push(result);
  }

  return { ...run, results };
}
