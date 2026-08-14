import { useState } from 'react';
import type { Environment } from '@flowcase/core/model';
import { api } from '../api.js';
import { useAsync } from '../hooks.js';
import { Badge, Button, Card, ErrorNote, Field, Input, Loading, Select } from '../ui.js';

/**
 * Environment profiles: the same tests pointed at local, staging or production.
 * Secrets are stored as the *name* of an environment variable, never the value,
 * so a project directory can be committed safely.
 */
export function EnvironmentsPage() {
  const environments = useAsync(() => api.listEnvironments(), []);
  const [editing, setEditing] = useState<Environment>();
  const [error, setError] = useState<string>();

  const save = async (): Promise<void> => {
    if (!editing) {
      return;
    }

    try {
      await api.saveEnvironment(editing.id, editing);
      setEditing(undefined);
      environments.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const create = async (): Promise<void> => {
    const name = window.prompt('Name the environment (for example "staging")');

    if (name) {
      const created = await api.createEnvironment({ name });
      environments.reload();
      setEditing(created);
    }
  };

  if (environments.loading) {
    return <Loading />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Environments</h1>
        <Button className="ml-auto" onClick={create}>
          + New environment
        </Button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-col gap-3">
        {(environments.data?.environments ?? []).map((environment) => (
          <Card key={environment.id} className="p-4">
            {editing?.id === environment.id ? (
              <EnvironmentForm
                environment={editing}
                onChange={setEditing}
                onSave={save}
                onCancel={() => setEditing(undefined)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{environment.name}</span>
                {environment.isDefault && <Badge tone="green">default</Badge>}
                <Badge>{environment.browser}</Badge>
                <Badge>{environment.headless ? 'headless' : 'headed'}</Badge>
                <span className="text-xs text-muted">{environment.baseUrl || 'no base URL'}</span>
                <span className="text-xs text-muted">
                  {Object.keys(environment.variables).length} variables ·{' '}
                  {Object.keys(environment.secretRefs).length} secrets
                </span>

                <div className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => setEditing(environment)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (window.confirm(`Delete environment "${environment.name}"?`)) {
                        await api.deleteEnvironment(environment.id);
                        environments.reload();
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function EnvironmentForm({
  environment,
  onChange,
  onSave,
  onCancel,
}: {
  environment: Environment;
  onChange: (environment: Environment) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<Environment>): void => onChange({ ...environment, ...patch });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={environment.name} onChange={(event) => set({ name: event.target.value })} />
        </Field>

        <Field label="Base URL" hint="Relative step URLs resolve against this.">
          <Input
            value={environment.baseUrl}
            placeholder="https://staging.example.com"
            onChange={(event) => set({ baseUrl: event.target.value })}
          />
        </Field>

        <Field label="Browser">
          <Select value={environment.browser} onChange={(event) => set({ browser: event.target.value as Environment['browser'] })}>
            <option value="chromium">Chromium</option>
            <option value="firefox">Firefox</option>
            <option value="webkit">WebKit (Safari)</option>
          </Select>
        </Field>

        <Field label="Viewport">
          <div className="flex gap-2">
            <Input
              type="number"
              value={environment.viewport.width}
              onChange={(event) => set({ viewport: { ...environment.viewport, width: Number(event.target.value) } })}
            />
            <Input
              type="number"
              value={environment.viewport.height}
              onChange={(event) => set({ viewport: { ...environment.viewport, height: Number(event.target.value) } })}
            />
          </div>
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Field
          label="Slow down (ms per action)"
          hint="0 runs at full speed. Try 300 to follow a headed run. Ignored when headless."
        >
          <Input
            type="number"
            min={0}
            max={5000}
            value={environment.slowMoMs}
            onChange={(event) => set({ slowMoMs: Number(event.target.value) })}
            className="w-40"
          />
        </Field>

        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={environment.highlightActions}
            onChange={(event) => set({ highlightActions: event.target.checked })}
          />
          Ripple where the runner clicks
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={environment.headless} onChange={(event) => set({ headless: event.target.checked })} />
          Run headless
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={environment.isDefault} onChange={(event) => set({ isDefault: event.target.checked })} />
          Use as the default
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={environment.ignoreHttpsErrors}
            onChange={(event) => set({ ignoreHttpsErrors: event.target.checked })}
          />
          Ignore HTTPS certificate errors
        </label>
      </div>

      <KeyValueEditor
        label="Variables"
        hint="Available in every step as {{name}}."
        values={environment.variables}
        onChange={(variables) => set({ variables })}
      />

      <KeyValueEditor
        label="Secrets"
        hint="Maps a variable name to the environment variable holding the real value. The value itself is never stored."
        values={environment.secretRefs}
        valuePlaceholder="MY_APP_PASSWORD"
        onChange={(secretRefs) => set({ secretRefs })}
      />

      <div className="flex gap-2">
        <Button variant="primary" onClick={onSave}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function KeyValueEditor({
  label,
  hint,
  values,
  valuePlaceholder,
  onChange,
}: {
  label: string;
  hint: string;
  values: Record<string, string>;
  valuePlaceholder?: string;
  onChange: (values: Record<string, string>) => void;
}) {
  const entries = Object.entries(values);

  return (
    <div>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mb-1 text-[11px] text-muted">{hint}</p>

      <div className="flex flex-col gap-1">
        {entries.map(([key, value], index) => (
          <div key={index} className="flex gap-2">
            <Input
              value={key}
              placeholder="name"
              onChange={(event) => {
                const next = entries.map(([entryKey, entryValue], position) =>
                  position === index ? [event.target.value, entryValue] : [entryKey, entryValue],
                );
                onChange(Object.fromEntries(next));
              }}
            />
            <Input
              value={value}
              placeholder={valuePlaceholder ?? 'value'}
              onChange={(event) => onChange({ ...values, [key]: event.target.value })}
            />
            <Button
              size="sm"
              variant="danger"
              onClick={() => onChange(Object.fromEntries(entries.filter((_, position) => position !== index)))}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>

      <Button size="sm" className="mt-1" onClick={() => onChange({ ...values, '': '' })}>
        + Add
      </Button>
    </div>
  );
}
