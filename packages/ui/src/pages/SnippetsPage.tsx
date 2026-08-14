import { useState } from 'react';
import type { Snippet, Step, VariableDef } from '@flowcase/core/model';
import { validateSnippet } from '@flowcase/core/model';
import { api } from '../api.js';
import { useAsync } from '../hooks.js';
import { StepList } from '../components/steps.js';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Loading, Textarea } from '../ui.js';

/**
 * Reusable fragments shared across tests — a login flow, a "add a line item"
 * block. A snippet is edited with the same step editor as a test, and inserted
 * into a test with a "Use snippet" step.
 */
export function SnippetsPage() {
  const snippets = useAsync(() => api.listSnippets(), []);
  const [editing, setEditing] = useState<Snippet>();
  const [error, setError] = useState<string>();

  const create = async (): Promise<void> => {
    const name = window.prompt('Name the snippet (for example "Log in as an admin")');

    if (!name) {
      return;
    }

    const created = await api.createSnippet({ name });
    snippets.reload();
    setEditing(created);
  };

  const save = async (): Promise<void> => {
    if (!editing) {
      return;
    }

    try {
      await api.saveSnippet(editing.id, editing);
      setError(undefined);
      setEditing(undefined);
      snippets.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  if (snippets.loading) {
    return <Loading />;
  }

  const list = snippets.data?.snippets ?? [];

  if (editing) {
    return (
      <SnippetEditor
        snippet={editing}
        error={error}
        onChange={setEditing}
        onSave={save}
        onCancel={() => setEditing(undefined)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Snippets</h1>
        <Button className="ml-auto" onClick={create}>
          + New snippet
        </Button>
      </div>

      {list.length === 0 ? (
        <EmptyState
          title="No snippets yet"
          description="Pull steps that repeat across tests into a snippet — change it once and every test that uses it follows."
          action={<Button variant="primary" onClick={create}>Create a snippet</Button>}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((snippet) => {
            const errors = validateSnippet(snippet).filter((issue) => issue.severity === 'error');

            return (
              <Card key={snippet.id} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{snippet.name}</span>
                  <span className="text-xs text-muted">v{snippet.version}</span>
                  <span className="text-xs text-muted">{countSteps(snippet.steps)} steps</span>

                  {snippet.parameters.length > 0 && (
                    <Badge tone="blue">
                      {snippet.parameters.length} parameter{snippet.parameters.length === 1 ? '' : 's'}
                    </Badge>
                  )}

                  {errors.length > 0 && <Badge tone="red">{errors.length} to fix</Badge>}
                  {snippet.description && <span className="text-xs text-muted">{snippet.description}</span>}

                  <div className="ml-auto flex gap-2">
                    <Button size="sm" onClick={() => setEditing(snippet)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (window.confirm(`Delete snippet "${snippet.name}"? Tests using it will report a broken reference.`)) {
                          await api.deleteSnippet(snippet.id);
                          snippets.reload();
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SnippetEditor({
  snippet,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  snippet: Snippet;
  error: string | undefined;
  onChange: (snippet: Snippet) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const issues = validateSnippet(snippet);
  const set = (patch: Partial<Snippet>): void => onChange({ ...snippet, ...patch });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          ← Snippets
        </Button>

        <Input value={snippet.name} onChange={(event) => set({ name: event.target.value })} className="max-w-sm font-semibold" />
        <span className="text-xs text-muted">v{snippet.version}</span>

        <Button variant="primary" className="ml-auto" onClick={onSave}>
          Save
        </Button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Description" className="sm:col-span-2">
            <Textarea
              rows={2}
              value={snippet.description}
              placeholder="What this fragment does, and when to reach for it."
              onChange={(event) => set({ description: event.target.value })}
            />
          </Field>
        </div>

        <ParametersEditor parameters={snippet.parameters} onChange={(parameters) => set({ parameters })} />
      </Card>

      <StepList
        steps={snippet.steps}
        issues={issues}
        dataSetNames={[]}
        snippets={[]}
        onChange={(steps: Step[]) => set({ steps })}
      />
    </div>
  );
}

function ParametersEditor({
  parameters,
  onChange,
}: {
  parameters: VariableDef[];
  onChange: (parameters: VariableDef[]) => void;
}) {
  const update = (index: number, patch: Partial<VariableDef>): void =>
    onChange(parameters.map((parameter, position) => (position === index ? { ...parameter, ...patch } : parameter)));

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium">Parameters</span>
        <Button
          size="sm"
          onClick={() =>
            onChange([...parameters, { name: '', type: 'string', defaultValue: '', required: false, source: 'input' }])
          }
        >
          + Add parameter
        </Button>
      </div>

      <p className="mb-2 text-[11px] text-muted">
        Values a test supplies when it inserts this snippet. Use them inside as {'{{name}}'}.
      </p>

      <div className="flex flex-col gap-2">
        {parameters.map((parameter, index) => (
          <div key={index} className="flex gap-2">
            <Input value={parameter.name} placeholder="email" onChange={(event) => update(index, { name: event.target.value })} />
            <Input
              value={parameter.defaultValue}
              placeholder="default value"
              onChange={(event) => update(index, { defaultValue: event.target.value })}
            />
            <Button size="sm" variant="danger" onClick={() => onChange(parameters.filter((_, position) => position !== index))}>
              ✕
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function countSteps(steps: Step[]): number {
  return steps.reduce((total, step) => total + 1 + countSteps(step.children), 0);
}
