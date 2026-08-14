import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import type { TestWithIssues } from '../api.js';
import { useAsync } from '../hooks.js';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Loading, Modal, Select } from '../ui.js';

const STATUS_TONE = {
  draft: 'neutral',
  in_review: 'amber',
  approved: 'green',
  archived: 'neutral',
} as const;

export function TestsPage() {
  const navigate = useNavigate();
  const tests = useAsync(() => api.listTests(), []);
  const environments = useAsync(() => api.listEnvironments(), []);

  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runOptions, setRunOptions] = useState<{ open: boolean; dryRun: boolean }>({ open: false, dryRun: false });
  const [environmentId, setEnvironmentId] = useState('');
  /** `''` means "leave it to the environment" — the run must not override it. */
  const [browserMode, setBrowserMode] = useState<'' | 'headed' | 'headless'>('');
  const [slowMo, setSlowMo] = useState('');
  const [busy, setBusy] = useState<string>();

  const filtered = useMemo(() => {
    const list = tests.data?.tests ?? [];
    const needle = search.trim().toLowerCase();

    return list.filter((test) => {
      const matchesSearch =
        needle.length === 0 ||
        test.name.toLowerCase().includes(needle) ||
        test.description.toLowerCase().includes(needle) ||
        test.tags.some((tag) => tag.toLowerCase().includes(needle));

      const matchesTags = tagFilter.every((tag) => test.tags.includes(tag));

      return matchesSearch && matchesTags;
    });
  }, [tests.data, search, tagFilter]);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const start = async (testIds: string[], dryRun: boolean): Promise<void> => {
    setBusy('run');

    try {
      const { runId } = await api.startRun({
        testIds,
        dryRun,
        ...(browserMode === '' ? {} : { headed: browserMode === 'headed' }),
        ...(slowMo.trim() === '' ? {} : { slowMo: Number(slowMo) }),
        ...(environmentId ? { environmentId } : {}),
      });
      navigate(`/runs/${runId}`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
      setRunOptions({ open: false, dryRun: false });
    }
  };

  const createTest = async (): Promise<void> => {
    const name = window.prompt('Name the new test');

    if (!name) {
      return;
    }

    const test = await api.createTest({ name });
    navigate(`/tests/${test.id}`);
  };

  if (tests.loading) {
    return <Loading />;
  }

  if (tests.error) {
    return <ErrorNote>{tests.error}</ErrorNote>;
  }

  const allTags = tests.data?.tags ?? [];
  const cycles = tests.data?.cycles ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Tests</h1>
        <span className="text-xs text-muted">{filtered.length} shown</span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button onClick={() => navigate('/recorder')}>● Record a test</Button>
          <Button onClick={createTest}>+ New test</Button>
          <Button
            variant="primary"
            disabled={busy === 'run'}
            onClick={() => setRunOptions({ open: true, dryRun: false })}
          >
            Run {selected.size > 0 ? `${selected.size} selected` : 'all'}
          </Button>
        </div>
      </div>

      {cycles.length > 0 && (
        <ErrorNote>
          Circular dependencies detected — these tests can never run:
          <ul className="mt-1 list-disc pl-5">
            {cycles.map((cycle) => (
              <li key={cycle.join('>')}>{cycle.join(' → ')}</li>
            ))}
          </ul>
        </ErrorNote>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search tests…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
        {allTags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() =>
              setTagFilter((current) =>
                current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag],
              )
            }
            className={`rounded border px-1.5 py-0.5 text-[11px] transition ${
              tagFilter.includes(tag)
                ? 'border-brand bg-brand/10 text-brand'
                : 'border-line text-muted hover:text-ink'
            }`}
          >
            {tag}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No tests yet"
          description="Record one by clicking through your app, or build it step by step in the editor. No code either way."
          action={<Button variant="primary" onClick={() => navigate('/recorder')}>Record a test</Button>}
        />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 font-medium">Test</th>
                <th className="px-3 py-2 font-medium">Tags</th>
                <th className="px-3 py-2 font-medium">Steps</th>
                <th className="px-3 py-2 font-medium">Depends on</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((test) => (
                <TestRow
                  key={test.id}
                  test={test}
                  selected={selected.has(test.id)}
                  onToggle={() => toggle(test.id)}
                  onOpen={() => navigate(`/tests/${test.id}`)}
                  onRun={() => start([test.id], false)}
                  allTests={tests.data?.tests ?? []}
                  onChanged={tests.reload}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {runOptions.open && (
        <Modal
          title={selected.size > 0 ? `Run ${selected.size} test(s)` : 'Run all tests'}
          onClose={() => setRunOptions({ open: false, dryRun: false })}
          footer={
            <>
              <Button onClick={() => start([...selected], true)} disabled={busy === 'run'}>
                Dry run (preview)
              </Button>
              <Button variant="primary" onClick={() => start([...selected], false)} disabled={busy === 'run'}>
                Run
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
              Dependencies of the selected tests are pulled in automatically and run first.
            </p>

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

            <Field label="Browser" hint="The environment decides unless you override it here.">
              <Select
                value={browserMode}
                onChange={(event) => setBrowserMode(event.target.value as '' | 'headed' | 'headless')}
              >
                <option value="">Use the environment setting</option>
                <option value="headed">Show the browser</option>
                <option value="headless">Hide the browser</option>
              </Select>
            </Field>

            {browserMode !== 'headless' && (
              <Field
                label="Slow down (ms per action)"
                hint="A headed run is otherwise too fast to follow. Try 300. Ignored when hidden."
              >
                <Input
                  value={slowMo}
                  inputMode="numeric"
                  placeholder="environment default"
                  onChange={(event) => setSlowMo(event.target.value)}
                  className="w-40"
                />
              </Field>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function TestRow({
  test,
  selected,
  onToggle,
  onOpen,
  onRun,
  allTests,
  onChanged,
}: {
  test: TestWithIssues;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRun: () => void;
  allTests: TestWithIssues[];
  onChanged: () => void;
}) {
  const errors = test.issues.filter((issue) => issue.severity === 'error');
  const dependencyNames = test.dependsOn
    .map((id) => allTests.find((candidate) => candidate.id === id)?.name ?? 'missing test')
    .join(', ');

  const remove = async (): Promise<void> => {
    if (window.confirm(`Delete "${test.name}"? Its version history goes too.`)) {
      await api.deleteTest(test.id);
      onChanged();
    }
  };

  return (
    <tr className="border-b border-line/60 last:border-0 hover:bg-canvas/60">
      <td className="px-3 py-2">
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${test.name}`} />
      </td>
      <td className="px-3 py-2">
        <button type="button" onClick={onOpen} className="text-left font-medium hover:text-brand">
          {test.name}
        </button>
        {test.description && <p className="text-xs text-muted">{test.description}</p>}
        {errors.length > 0 && (
          <p className="text-xs text-red-600 dark:text-red-400">
            {errors.length} problem{errors.length === 1 ? '' : 's'} to fix
          </p>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {test.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
      </td>
      <td className="px-3 py-2 text-muted">{countSteps(test)}</td>
      <td className="max-w-40 truncate px-3 py-2 text-xs text-muted">{dependencyNames || '—'}</td>
      <td className="px-3 py-2">
        <Badge tone={STATUS_TONE[test.status]}>{test.status.replace('_', ' ')}</Badge>
        <span className="ml-1 text-[11px] text-muted">v{test.version}</span>
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-1">
          <Button size="sm" onClick={onRun}>
            Run
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpen}>
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={remove}>
            Delete
          </Button>
        </div>
      </td>
    </tr>
  );
}

function countSteps(test: TestWithIssues): number {
  let count = 0;

  const walk = (steps: TestWithIssues['steps']): void => {
    for (const step of steps) {
      count += 1;
      walk(step.children);
    }
  };

  walk(test.steps);

  return count;
}
