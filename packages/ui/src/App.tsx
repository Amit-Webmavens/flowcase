import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import type { RunSummary } from '@flowcase/core/model';
import { useServerEvents } from './hooks.js';
import { Badge } from './ui.js';

const NAV = [
  { to: '/', label: 'Tests', end: true },
  { to: '/runs', label: 'Runs', end: false },
  { to: '/recorder', label: 'Recorder', end: false },
  { to: '/snippets', label: 'Snippets', end: false },
  { to: '/schedules', label: 'Schedules', end: false },
  { to: '/environments', label: 'Environments', end: false },
];

/**
 * App shell. Holds the one live connection to the server and surfaces global
 * state — how many runs are in flight, whether a recording is active — so those
 * are visible from every screen.
 */
export function App() {
  const [activeRuns, setActiveRuns] = useState<RunSummary[]>([]);
  const [recording, setRecording] = useState(false);
  const navigate = useNavigate();

  useServerEvents((event) => {
    switch (event.type) {
      case 'snapshot':
        setActiveRuns(event.activeRuns);
        setRecording(event.recording);
        break;
      case 'run:start':
        setActiveRuns((current) => [
          ...current.filter((run) => run.id !== event.runId),
          { ...emptySummary(event.runId), status: 'running' },
        ]);
        break;
      case 'run:end':
        setActiveRuns((current) => current.filter((run) => run.id !== event.runId));
        break;
      case 'recorder:started':
        setRecording(true);
        break;
      case 'recorder:stopped':
        setRecording(false);
        break;
      default:
        break;
    }
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-4 py-2.5">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <span className="grid h-6 w-6 place-items-center rounded bg-brand text-xs text-white">fc</span>
          flowcase
        </button>

        <nav className="flex items-center gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-md px-2.5 py-1 text-sm transition ${
                  isActive ? 'bg-canvas font-medium text-ink' : 'text-muted hover:text-ink'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {recording && <Badge tone="red">● Recording</Badge>}
          {activeRuns.length > 0 && (
            <button type="button" onClick={() => navigate('/runs')}>
              <Badge tone="blue">
                {activeRuns.length} run{activeRuns.length === 1 ? '' : 's'} in progress
              </Badge>
            </button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function emptySummary(id: string): RunSummary {
  return {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    testIds: [],
    testNames: [],
    tags: [],
    triggeredBy: 'ui',
    dryRun: false,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
}
