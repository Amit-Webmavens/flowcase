import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Step } from '@flowcase/core/model';
import { summarizeStep } from '@flowcase/core/model';
import { api } from '../api.js';
import type { PrerequisiteResult } from '../hooks.js';
import { formatDuration, useAsync, useServerEvents } from '../hooks.js';
import { Badge, Button, Card, ErrorNote, Field, Input, Select } from '../ui.js';

interface SetupProgress {
  name: string;
  index: number;
  total: number;
  label?: string;
}

/**
 * The no-code entry point: click through the app in a real browser and the steps
 * appear here as they happen. Nothing is written to disk until the tester saves.
 *
 * A recording can start from a chain of existing tests, so a flow that lives
 * behind a login and a created record does not have to be recorded from scratch
 * every time.
 */
export function RecorderPage() {
  const navigate = useNavigate();
  const environments = useAsync(() => api.listEnvironments(), []);
  const tests = useAsync(() => api.listTests(), []);
  const status = useAsync(() => api.recorderStatus(), []);

  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [paused, setPaused] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [currentUrl, setCurrentUrl] = useState('');
  const [startUrl, setStartUrl] = useState('/');
  const [environmentId, setEnvironmentId] = useState('');
  const [error, setError] = useState<string>();
  const [saveTarget, setSaveTarget] = useState('');
  const [testName, setTestName] = useState('');

  const [prerequisiteIds, setPrerequisiteIds] = useState<string[]>([]);
  const [setupProgress, setSetupProgress] = useState<SetupProgress>();
  const [setupResults, setSetupResults] = useState<PrerequisiteResult[]>([]);
  /** The chain that actually ran, dependencies included — becomes `dependsOn`. */
  const [chainIds, setChainIds] = useState<string[]>([]);
  const [linkChain, setLinkChain] = useState(true);

  const testsById = new Map((tests.data?.tests ?? []).map((test) => [test.id, test]));
  const nameOf = (id: string): string => testsById.get(id)?.name ?? id;

  useServerEvents((event) => {
    switch (event.type) {
      case 'prerequisite:test':
        setSetupProgress({ name: event.name, index: event.index, total: event.total });
        break;
      case 'prerequisite:step':
        setSetupProgress((current) => (current ? { ...current, label: event.label } : current));
        break;
      case 'prerequisite:result':
        setSetupResults((current) => [...current, event.result]);
        break;
      case 'recorder:setupFailed':
        setStarting(false);
        setSetupProgress(undefined);
        break;
      case 'recorder:started':
        setRecording(true);
        setStarting(false);
        setSteps([]);
        setSetupProgress(undefined);
        setChainIds(event.prerequisiteTestIds ?? []);
        break;
      case 'recorder:step':
        setSteps((current) => [...current, event.step]);
        break;
      case 'recorder:navigate':
        setCurrentUrl(event.url);
        break;
      case 'recorder:mode':
        setPaused(event.mode === 'paused');
        break;
      case 'recorder:stopped':
        setRecording(false);
        setSteps(event.steps);
        break;
      default:
        break;
    }
  });

  const togglePrerequisite = (id: string, checked: boolean): void => {
    setPrerequisiteIds((current) => {
      const next = checked ? [...current, id] : current.filter((entry) => entry !== id);

      // The point of a setup chain is to continue where it stops, so the default
      // "go to /" would undo it. Clear it once, the first time one is chosen.
      if (checked && current.length === 0 && startUrl === '/') {
        setStartUrl('');
      }

      return next;
    });
  };

  const start = async (): Promise<void> => {
    setError(undefined);
    setSetupResults([]);
    setSetupProgress(undefined);
    setStarting(true);

    try {
      await api.startRecorder({
        startUrl,
        ...(environmentId ? { environmentId } : {}),
        ...(prerequisiteIds.length > 0 ? { prerequisiteTestIds: prerequisiteIds } : {}),
      });
      setRecording(true);
      setSteps([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  };

  const stop = async (): Promise<void> => {
    const result = await api.stopRecorder();
    setRecording(false);
    setStarting(false);
    setSteps(result.steps);
  };

  const togglePause = async (): Promise<void> => {
    const next = paused ? 'record' : 'paused';
    await api.recorderMode(next);
    setPaused(!paused);
  };

  const save = async (): Promise<void> => {
    if (steps.length === 0) {
      return;
    }

    if (saveTarget === '') {
      const test = await api.createTest({
        name: testName.trim() || 'Recorded test',
        steps,
        // Whatever got the browser into this state at record time has to happen
        // again at run time, or the recording can never pass on its own.
        ...(linkChain && chainIds.length > 0 ? { dependsOn: chainIds } : {}),
      });
      navigate(`/tests/${test.id}`);
      return;
    }

    const existing = await api.getTest(saveTarget);
    const saved = await api.saveTest(saveTarget, { ...existing, steps: [...existing.steps, ...steps] });
    navigate(`/tests/${saved.id}`);
  };

  const alreadyRecording = status.data?.recording && !recording;
  const availableTests = tests.data?.tests ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Recorder</h1>

      {error && <ErrorNote>{error}</ErrorNote>}

      {alreadyRecording && (
        <ErrorNote>
          A recording is already running in another tab or window.
          <Button size="sm" className="ml-2" onClick={stop}>
            Stop it
          </Button>
        </ErrorNote>
      )}

      <Card className="p-4">
        {!recording ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label="Start at"
                hint={
                  prerequisiteIds.length > 0
                    ? 'Leave blank to carry on from where the setup tests finish.'
                    : "Relative paths use the environment's base URL."
                }
              >
                <Input
                  value={startUrl}
                  onChange={(event) => setStartUrl(event.target.value)}
                  placeholder={prerequisiteIds.length > 0 ? 'stay where the setup ends' : '/'}
                  className="w-64"
                />
              </Field>

              <Field label="Environment">
                <Select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>
                  <option value="">Project default</option>
                  {(environments.data?.environments ?? []).map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name} — {environment.baseUrl || 'no base URL'}
                    </option>
                  ))}
                </Select>
              </Field>

              <Button variant="primary" onClick={start} disabled={starting} className="mb-0.5">
                {starting
                  ? 'Setting up…'
                  : prerequisiteIds.length > 0
                    ? '● Run setup, then record'
                    : '● Start recording'}
              </Button>
            </div>

            <div>
              <p className="text-sm font-medium">Run these tests first</p>
              <p className="mb-2 text-xs text-muted">
                They run in a real browser before recording starts, so you begin already logged in and with any
                records they create already there. Their own dependencies are pulled in automatically, and what you
                record is chained to them when you save.
              </p>

              {availableTests.length === 0 ? (
                <p className="text-xs text-muted">No tests yet — record one first and it will appear here.</p>
              ) : (
                <div className="max-h-44 overflow-y-auto rounded border border-line">
                  {availableTests.map((test) => (
                    <label
                      key={test.id}
                      className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-sm last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        checked={prerequisiteIds.includes(test.id)}
                        onChange={(event) => togglePrerequisite(test.id, event.target.checked)}
                      />
                      <span className="truncate">{test.name}</span>
                      {test.dependsOn.length > 0 && (
                        <Badge tone="blue">+{test.dependsOn.length} dependency</Badge>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {starting && setupProgress && (
              <div className="rounded border border-line bg-canvas px-3 py-2 text-sm">
                <span className="font-medium">
                  Running “{setupProgress.name}” ({setupProgress.index + 1} of {setupProgress.total})
                </span>
                {setupProgress.label && <span className="ml-2 text-xs text-muted">{setupProgress.label}</span>}
              </div>
            )}

            {setupResults.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs">
                {setupResults.map((result) => (
                  <li key={result.testId} className="flex items-center gap-2">
                    <Badge tone={result.status === 'passed' ? 'green' : 'red'}>{result.status}</Badge>
                    <span>{result.name}</span>
                    <span className="text-muted">{formatDuration(result.durationMs)}</span>
                    {result.failedStep && <span className="text-muted">— {result.failedStep}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={paused ? 'amber' : 'red'}>{paused ? '❚❚ Paused' : '● Recording'}</Badge>
            <span className="truncate text-xs text-muted">{currentUrl || startUrl}</span>

            <div className="ml-auto flex gap-2">
              <Button onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</Button>
              <Button variant="primary" onClick={stop}>
                Stop and review
              </Button>
            </div>
          </div>
        )}

        {recording && (
          <>
            {chainIds.length > 0 && (
              <p className="mt-3 text-xs text-muted">
                Starting from: {chainIds.map(nameOf).join(' → ')}. Only what you do from here is recorded.
              </p>
            )}
            <p className="mt-3 text-xs text-muted">
              A browser window is open. Use the app as a tester would — every click, entry and selection becomes a
              step. The toolbar at the bottom of that window can pause recording or capture a check on any element.
            </p>
          </>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <h2 className="text-sm font-medium">Captured steps</h2>
          <span className="text-xs text-muted">{steps.length}</span>
        </div>

        {steps.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            Nothing captured yet. Start recording and interact with your app.
          </p>
        ) : (
          <ol className="divide-y divide-line">
            {steps.map((step, index) => (
              <li key={`${step.id}-${index}`} className="flex items-center gap-2 px-4 py-1.5 text-sm">
                <span className="w-6 text-right text-xs text-muted">{index + 1}</span>
                <Badge>{step.kind}</Badge>
                <span className="truncate">{summarizeStep(step)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {steps.length > 0 && !recording && (
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-medium">Save this recording</h2>

          <div className="flex flex-wrap items-end gap-3">
            <Field label="Save as">
              <Select value={saveTarget} onChange={(event) => setSaveTarget(event.target.value)}>
                <option value="">A new test</option>
                {availableTests.map((test) => (
                  <option key={test.id} value={test.id}>
                    Append to “{test.name}”
                  </option>
                ))}
              </Select>
            </Field>

            {saveTarget === '' && (
              <Field label="Name">
                <Input
                  value={testName}
                  placeholder="Create an order"
                  onChange={(event) => setTestName(event.target.value)}
                  className="w-64"
                />
              </Field>
            )}

            <Button variant="primary" onClick={save} className="mb-0.5">
              Save
            </Button>
            <Button onClick={() => setSteps([])} className="mb-0.5">
              Discard
            </Button>
          </div>

          {saveTarget === '' && chainIds.length > 0 && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={linkChain}
                onChange={(event) => setLinkChain(event.target.checked)}
              />
              Run {chainIds.map(nameOf).join(' → ')} before this test
              <span className="text-xs text-muted">
                — keep this on, or the recording will start from a logged-out browser.
              </span>
            </label>
          )}
        </Card>
      )}
    </div>
  );
}
