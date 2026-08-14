import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunSummary } from '@flowcase/core/model';
import { api } from '../api.js';
import { formatDuration, formatWhen, useAsync, useServerEvents } from '../hooks.js';
import { Badge, Button, Card, EmptyState, ErrorNote, Loading, StatusIcon, statusTone } from '../ui.js';

/**
 * Run history plus a live view of anything in flight — several runs can be in
 * progress at once, and each shows which test it is on right now.
 */
export function RunsPage() {
  const navigate = useNavigate();
  const runs = useAsync(() => api.listRuns(), []);
  const [live, setLive] = useState<Record<string, { testName: string; step: string }>>({});

  useServerEvents((event) => {
    if (event.type === 'run:start' || event.type === 'run:end') {
      runs.reload();
      if (event.type === 'run:end') {
        setLive((current) => {
          const next = { ...current };
          delete next[event.runId];
          return next;
        });
      }
      return;
    }

    if (event.type === 'test:start') {
      setLive((current) => ({ ...current, [event.runId]: { testName: event.testName, step: '' } }));
      return;
    }

    if (event.type === 'step:start') {
      setLive((current) => ({
        ...current,
        [event.runId]: { testName: current[event.runId]?.testName ?? '', step: event.step.label },
      }));
    }
  });

  if (runs.loading) {
    return <Loading />;
  }

  if (runs.error) {
    return <ErrorNote>{runs.error}</ErrorNote>;
  }

  const active = runs.data?.active ?? [];
  const history = (runs.data?.runs ?? []).filter((run) => !active.some((entry) => entry.id === run.id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Runs</h1>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={runs.reload}>
          Refresh
        </Button>
      </div>

      {active.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted">In progress</p>
          {active.map((run) => (
            <Card key={run.id} className="border-blue-500/40 p-3">
              <button
                type="button"
                onClick={() => navigate(`/runs/${run.id}`)}
                className="flex w-full flex-wrap items-center gap-2 text-left"
              >
                <StatusIcon status="running" />
                <span className="text-sm font-medium">{live[run.id]?.testName || 'Starting…'}</span>
                <span className="truncate text-xs text-muted">{live[run.id]?.step}</span>
                <span className="ml-auto text-xs text-muted">{formatWhen(run.startedAt)}</span>
              </button>
            </Card>
          ))}
        </div>
      )}

      {history.length === 0 && active.length === 0 ? (
        <EmptyState title="No runs yet" description="Run a test and its results, artifacts and logs will appear here." />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 font-medium">Tests</th>
                <th className="px-3 py-2 font-medium">Environment</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {history.map((run) => (
                <RunRow key={run.id} run={run} onOpen={() => navigate(`/runs/${run.id}`)} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function RunRow({ run, onOpen }: { run: RunSummary; onOpen: () => void }) {
  return (
    <tr className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-canvas/60" onClick={onOpen}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <Badge tone={statusTone(run.status)}>{run.status}</Badge>
          {run.dryRun && <Badge tone="purple">preview</Badge>}
          <span className="text-xs text-muted">
            {run.passed > 0 && <span className="text-emerald-600 dark:text-emerald-400">{run.passed} passed</span>}
            {run.failed > 0 && <span className="ml-1 text-red-600 dark:text-red-400">{run.failed} failed</span>}
            {run.skipped > 0 && <span className="ml-1">{run.skipped} skipped</span>}
          </span>
        </div>
      </td>
      <td className="max-w-64 truncate px-3 py-2 text-xs">{run.testNames.join(', ') || '—'}</td>
      <td className="px-3 py-2 text-xs text-muted">{run.environmentName ?? '—'}</td>
      <td className="px-3 py-2 text-xs text-muted">{formatWhen(run.startedAt)}</td>
      <td className="px-3 py-2 text-xs text-muted">{formatDuration(run.durationMs)}</td>
    </tr>
  );
}
