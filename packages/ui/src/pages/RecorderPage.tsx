import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Step } from '@flowcase/core/model';
import { summarizeStep } from '@flowcase/core/model';
import { api } from '../api.js';
import { useAsync, useServerEvents } from '../hooks.js';
import { Badge, Button, Card, ErrorNote, Field, Input, Select } from '../ui.js';

/**
 * The no-code entry point: click through the app in a real browser and the steps
 * appear here as they happen. Nothing is written to disk until the tester saves.
 */
export function RecorderPage() {
  const navigate = useNavigate();
  const environments = useAsync(() => api.listEnvironments(), []);
  const tests = useAsync(() => api.listTests(), []);
  const status = useAsync(() => api.recorderStatus(), []);

  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [currentUrl, setCurrentUrl] = useState('');
  const [startUrl, setStartUrl] = useState('/');
  const [environmentId, setEnvironmentId] = useState('');
  const [error, setError] = useState<string>();
  const [saveTarget, setSaveTarget] = useState('');
  const [testName, setTestName] = useState('');

  useServerEvents((event) => {
    switch (event.type) {
      case 'recorder:started':
        setRecording(true);
        setSteps([]);
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

  const start = async (): Promise<void> => {
    setError(undefined);

    try {
      await api.startRecorder({ startUrl, ...(environmentId ? { environmentId } : {}) });
      setRecording(true);
      setSteps([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const stop = async (): Promise<void> => {
    const result = await api.stopRecorder();
    setRecording(false);
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
      const test = await api.createTest({ name: testName.trim() || 'Recorded test', steps });
      navigate(`/tests/${test.id}`);
      return;
    }

    const existing = await api.getTest(saveTarget);
    const saved = await api.saveTest(saveTarget, { ...existing, steps: [...existing.steps, ...steps] });
    navigate(`/tests/${saved.id}`);
  };

  const alreadyRecording = status.data?.recording && !recording;

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
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Start at" hint="Relative paths use the environment's base URL.">
              <Input value={startUrl} onChange={(event) => setStartUrl(event.target.value)} className="w-64" />
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

            <Button variant="primary" onClick={start} className="mb-0.5">
              ● Start recording
            </Button>
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
          <p className="mt-3 text-xs text-muted">
            A browser window is open. Use the app as a tester would — every click, entry and selection becomes a
            step. The toolbar at the bottom of that window can pause recording or capture a check on any element.
          </p>
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
                {(tests.data?.tests ?? []).map((test) => (
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
        </Card>
      )}
    </div>
  );
}
