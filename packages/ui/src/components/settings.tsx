import { useState } from 'react';
import type { DataSet, Environment, RouteMock, TestCase, VariableDef } from '@flowcase/core/model';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '../ui.js';

export function SettingsTab({
  test,
  allTests,
  environments,
  sessions,
  onChange,
}: {
  test: TestCase;
  allTests: Array<{ id: string; name: string }>;
  environments: Environment[];
  sessions: string[];
  onChange: (patch: Partial<TestCase>) => void;
}) {
  const [tagDraft, setTagDraft] = useState('');

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Description" className="sm:col-span-2">
            <Textarea
              rows={2}
              value={test.description}
              placeholder="What this test proves, in plain language."
              onChange={(event) => onChange({ description: event.target.value })}
            />
          </Field>

          <Field label="Tags" hint="Used to filter which tests a run includes." className="sm:col-span-2">
            <div className="flex flex-wrap items-center gap-1">
              {test.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onChange({ tags: test.tags.filter((value) => value !== tag) })}
                  title="Remove tag"
                >
                  <Badge tone="blue">{tag} ✕</Badge>
                </button>
              ))}
              <Input
                value={tagDraft}
                placeholder="Add a tag and press Enter"
                className="max-w-48"
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && tagDraft.trim().length > 0) {
                    event.preventDefault();
                    onChange({ tags: [...new Set([...test.tags, tagDraft.trim()])] });
                    setTagDraft('');
                  }
                }}
              />
            </div>
          </Field>

          <Field label="Environment" hint="Overridable when a run starts.">
            <Select value={test.environmentId ?? ''} onChange={(event) => onChange({ environmentId: event.target.value || undefined })}>
              <option value="">Project default</option>
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Default step timeout (ms)">
            <Input
              type="number"
              value={test.defaultTimeoutMs}
              onChange={(event) => onChange({ defaultTimeoutMs: Number(event.target.value) })}
            />
          </Field>

          <Field label="Default retry attempts" hint="Applies to steps that don't set their own.">
            <Input
              type="number"
              min={1}
              value={test.defaultRetry?.attempts ?? 1}
              onChange={(event) =>
                onChange({
                  defaultRetry: {
                    attempts: Number(event.target.value),
                    delayMs: test.defaultRetry?.delayMs ?? 500,
                    backoff: test.defaultRetry?.backoff ?? 'fixed',
                  },
                })
              }
            />
          </Field>

          <Field label="Retry backoff">
            <Select
              value={test.defaultRetry?.backoff ?? 'fixed'}
              onChange={(event) =>
                onChange({
                  defaultRetry: {
                    attempts: test.defaultRetry?.attempts ?? 1,
                    delayMs: test.defaultRetry?.delayMs ?? 500,
                    backoff: event.target.value as 'fixed' | 'linear' | 'exponential',
                  },
                })
              }
            >
              <option value="fixed">Fixed delay</option>
              <option value="linear">Linear</option>
              <option value="exponential">Exponential</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-medium">Runs after</h3>
        <p className="mb-2 text-xs text-muted">
          Pick the tests this one builds on. Running this test alone will run them first, and any value they
          capture is available here.
        </p>

        <div className="flex flex-col gap-1">
          {allTests
            .filter((candidate) => candidate.id !== test.id)
            .map((candidate) => (
              <label key={candidate.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={test.dependsOn.includes(candidate.id)}
                  onChange={(event) =>
                    onChange({
                      dependsOn: event.target.checked
                        ? [...test.dependsOn, candidate.id]
                        : test.dependsOn.filter((id) => id !== candidate.id),
                    })
                  }
                />
                {candidate.name}
              </label>
            ))}
          {allTests.length <= 1 && <p className="text-xs text-muted">No other tests to depend on yet.</p>}
        </div>
      </Card>

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-medium">Session</h3>
        <p className="mb-2 text-xs text-muted">
          Reuse a login instead of repeating it. A test that saves a session shares it with everything that
          depends on it.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Start from a saved session">
            <Select
              value={test.auth.session ?? ''}
              onChange={(event) => onChange({ auth: { ...test.auth, session: event.target.value || undefined } })}
            >
              <option value="">None</option>
              {sessions.map((session) => (
                <option key={session} value={session}>
                  {session}
                </option>
              ))}
            </Select>
          </Field>

          <label className="flex items-end gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={test.auth.inheritFromDependency}
              onChange={(event) => onChange({ auth: { ...test.auth, inheritFromDependency: event.target.checked } })}
            />
            Carry the browser session over from the test this one depends on
          </label>
        </div>
      </Card>

      <MockEditor mocks={test.mocks} onChange={(mocks) => onChange({ mocks })} />
    </div>
  );
}

function MockEditor({ mocks, onChange }: { mocks: RouteMock[]; onChange: (mocks: RouteMock[]) => void }) {
  const update = (index: number, patch: Partial<RouteMock>): void =>
    onChange(mocks.map((mock, position) => (position === index ? { ...mock, ...patch } : mock)));

  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-medium">Network mocks</h3>
        <Button
          size="sm"
          onClick={() =>
            onChange([
              ...mocks,
              {
                id: `mock_${Math.random().toString(36).slice(2, 9)}`,
                urlPattern: '**/api/',
                method: 'ANY',
                status: 200,
                contentType: 'application/json',
                body: '{}',
                headers: {},
                delayMs: 0,
                times: 0,
                abort: false,
                enabled: true,
              },
            ])
          }
        >
          + Add mock
        </Button>
      </div>

      <p className="mb-2 text-xs text-muted">
        Intercept requests and return a fixed response — useful for forcing error states or removing a slow
        third-party call.
      </p>

      <div className="flex flex-col gap-3">
        {mocks.map((mock, index) => (
          <div key={mock.id} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-2">
            <Field label="URL pattern" hint="Glob, or re: for a regular expression.">
              <Input value={mock.urlPattern} onChange={(event) => update(index, { urlPattern: event.target.value })} />
            </Field>

            <Field label="Method">
              <Select value={mock.method} onChange={(event) => update(index, { method: event.target.value as RouteMock['method'] })}>
                {['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Status code">
              <Input type="number" value={mock.status} onChange={(event) => update(index, { status: Number(event.target.value) })} />
            </Field>

            <Field label="Delay (ms)">
              <Input type="number" value={mock.delayMs} onChange={(event) => update(index, { delayMs: Number(event.target.value) })} />
            </Field>

            <Field label="Response body" className="sm:col-span-2">
              <Textarea rows={3} value={mock.body} onChange={(event) => update(index, { body: event.target.value })} />
            </Field>

            <div className="flex items-center justify-between sm:col-span-2">
              <div className="flex gap-4 text-xs">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={mock.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} />
                  Enabled
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={mock.abort} onChange={(event) => update(index, { abort: event.target.checked })} />
                  Fail the request instead of responding
                </label>
              </div>
              <Button size="sm" variant="danger" onClick={() => onChange(mocks.filter((_, position) => position !== index))}>
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function DataTab({
  test,
  onChange,
}: {
  test: TestCase;
  onChange: (patch: Partial<TestCase>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <VariablesEditor variables={test.variables} onChange={(variables) => onChange({ variables })} />

      <Card className="p-4">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-medium">Data sets</h3>
          <Button
            size="sm"
            onClick={() =>
              onChange({
                dataSets: [...test.dataSets, { name: `set${test.dataSets.length + 1}`, columns: ['column1'], rows: [{ column1: '' }] }],
              })
            }
          >
            + Add data set
          </Button>
        </div>

        <p className="mb-2 text-xs text-muted">
          A table of values. Use one to repeat a step per row, or to run the whole test once per row.
        </p>

        <Field label="Run the whole test once per row of">
          <Select value={test.dataDrivenSet ?? ''} onChange={(event) => onChange({ dataDrivenSet: event.target.value || undefined })}>
            <option value="">Don't — run once</option>
            {test.dataSets.map((set) => (
              <option key={set.name} value={set.name}>
                {set.name} ({set.rows.length} rows)
              </option>
            ))}
          </Select>
        </Field>

        <div className="mt-3 flex flex-col gap-4">
          {test.dataSets.map((set, index) => (
            <DataSetEditor
              key={index}
              set={set}
              onChange={(next) => onChange({ dataSets: test.dataSets.map((entry, position) => (position === index ? next : entry)) })}
              onRemove={() => onChange({ dataSets: test.dataSets.filter((_, position) => position !== index) })}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function VariablesEditor({
  variables,
  onChange,
}: {
  variables: VariableDef[];
  onChange: (variables: VariableDef[]) => void;
}) {
  const update = (index: number, patch: Partial<VariableDef>): void =>
    onChange(variables.map((variable, position) => (position === index ? { ...variable, ...patch } : variable)));

  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-medium">Variables</h3>
        <Button
          size="sm"
          onClick={() =>
            onChange([...variables, { name: '', type: 'string', defaultValue: '', required: false, source: 'input' }])
          }
        >
          + Add variable
        </Button>
      </div>

      <p className="mb-2 text-xs text-muted">
        Reference these anywhere as {'{{name}}'}. Built-in generators work too: {'{{$uuid}}'},{' '}
        {'{{$randomEmail}}'}, {'{{$date}}'}, {'{{$randomInt(1,99)}}'}.
      </p>

      <div className="flex flex-col gap-2">
        {variables.map((variable, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-4">
            <Input value={variable.name} placeholder="name" onChange={(event) => update(index, { name: event.target.value })} />
            <Select value={variable.type} onChange={(event) => update(index, { type: event.target.value as VariableDef['type'] })}>
              <option value="string">text</option>
              <option value="number">number</option>
              <option value="boolean">true/false</option>
              <option value="secret">secret</option>
              <option value="date">date</option>
            </Select>
            <Input value={variable.defaultValue} placeholder="default value" onChange={(event) => update(index, { defaultValue: event.target.value })} />
            <div className="flex items-center gap-2">
              <Select value={variable.source} onChange={(event) => update(index, { source: event.target.value as VariableDef['source'] })}>
                <option value="input">set at run time</option>
                <option value="runtime">captured by a step</option>
                <option value="env">from the environment</option>
              </Select>
              <Button size="sm" variant="danger" onClick={() => onChange(variables.filter((_, position) => position !== index))}>
                ✕
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function DataSetEditor({
  set,
  onChange,
  onRemove,
}: {
  set: DataSet;
  onChange: (set: DataSet) => void;
  onRemove: () => void;
}) {
  const [pasting, setPasting] = useState(false);
  const [csv, setCsv] = useState('');

  const applyCsv = (): void => {
    const lines = csv.trim().split('\n').filter((line) => line.trim().length > 0);
    const [headerLine, ...rest] = lines;

    if (!headerLine) {
      return;
    }

    const columns = headerLine.split(',').map((value) => value.trim());
    const rows = rest.map((line) => {
      const cells = line.split(',').map((value) => value.trim());
      return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? '']));
    });

    onChange({ ...set, columns, rows });
    setPasting(false);
    setCsv('');
  };

  return (
    <div className="rounded-md border border-line p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          value={set.name}
          className="max-w-48"
          onChange={(event) => onChange({ ...set, name: event.target.value })}
        />
        <span className="text-xs text-muted">
          {set.rows.length} rows × {set.columns.length} columns
        </span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" onClick={() => setPasting((value) => !value)}>
            Paste CSV
          </Button>
          <Button
            size="sm"
            onClick={() => onChange({ ...set, columns: [...set.columns, `column${set.columns.length + 1}`] })}
          >
            + Column
          </Button>
          <Button size="sm" onClick={() => onChange({ ...set, rows: [...set.rows, {}] })}>
            + Row
          </Button>
          <Button size="sm" variant="danger" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>

      {pasting && (
        <div className="mb-2 flex flex-col gap-2">
          <Textarea
            rows={4}
            value={csv}
            placeholder={'email,password\nada@example.com,secret\ngrace@example.com,hunter2'}
            onChange={(event) => setCsv(event.target.value)}
          />
          <div>
            <Button size="sm" variant="primary" onClick={applyCsv}>
              Replace rows with this
            </Button>
          </div>
        </div>
      )}

      <div className="scroll-x">
        <table className="w-full text-xs">
          <thead>
            <tr>
              {set.columns.map((column, index) => (
                <th key={index} className="p-1 text-left">
                  <Input
                    value={column}
                    onChange={(event) =>
                      onChange({
                        ...set,
                        columns: set.columns.map((entry, position) => (position === index ? event.target.value : entry)),
                      })
                    }
                  />
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {set.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {set.columns.map((column) => (
                  <td key={column} className="p-1">
                    <Input
                      value={String(row[column] ?? '')}
                      onChange={(event) =>
                        onChange({
                          ...set,
                          rows: set.rows.map((entry, position) =>
                            position === rowIndex ? { ...entry, [column]: event.target.value } : entry,
                          ),
                        })
                      }
                    />
                  </td>
                ))}
                <td className="p-1">
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => onChange({ ...set, rows: set.rows.filter((_, position) => position !== rowIndex) })}
                  >
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
