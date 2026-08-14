import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Step, TestCase, ValidationIssue } from '@flowcase/core/model';
import { validateTest } from '@flowcase/core/model';
import { api } from '../api.js';
import { useAsync } from '../hooks.js';
import { StepList } from '../components/steps.js';
import { DataTab, SettingsTab } from '../components/settings.js';
import { ApprovalBar, HistoryTab } from '../components/history.js';
import { Badge, Button, ErrorNote, Input, Loading, Modal } from '../ui.js';

type Tab = 'steps' | 'settings' | 'data' | 'history';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'steps', label: 'Steps' },
  { id: 'settings', label: 'Settings' },
  { id: 'data', label: 'Variables & data' },
  { id: 'history', label: 'History' },
];

export function TestEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const loaded = useAsync(() => api.getTest(id), [id]);
  const testList = useAsync(() => api.listTests(), []);
  const snippets = useAsync(() => api.listSnippets(), []);
  const environments = useAsync(() => api.listEnvironments(), []);

  const [draft, setDraft] = useState<TestCase>();
  const [tab, setTab] = useState<Tab>('steps');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [exported, setExported] = useState<{ filename: string; code: string }>();

  useEffect(() => {
    if (loaded.data) {
      setDraft(loaded.data);
      setDirty(false);
    }
  }, [loaded.data]);

  // A tester who edits and clicks away should not silently lose work.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (dirty) {
        event.preventDefault();
      }
    };

    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (loaded.loading || !draft) {
    return loaded.error ? <ErrorNote>{loaded.error}</ErrorNote> : <Loading />;
  }

  const snippetList = snippets.data?.snippets ?? [];
  const issues: ValidationIssue[] = validateTest(draft, {
    snippetIds: new Set(snippetList.map((snippet) => snippet.id)),
  });
  const errors = issues.filter((issue) => issue.severity === 'error');

  const patch = (changes: Partial<TestCase>): void => {
    setDraft({ ...draft, ...changes });
    setDirty(true);
  };

  const setSteps = (steps: Step[]): void => patch({ steps });

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(undefined);

    try {
      const saved = await api.saveTest(draft.id, draft);
      setDraft(saved);
      setDirty(false);
      testList.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const run = async (dryRun: boolean): Promise<void> => {
    if (dirty) {
      await save();
    }

    const { runId } = await api.startRun({ testIds: [draft.id], dryRun });
    navigate(`/runs/${runId}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
          ← Tests
        </Button>

        <Input
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
          className="max-w-sm text-base font-semibold"
        />

        <span className="text-xs text-muted">v{draft.version}</span>
        {dirty && <Badge tone="amber">unsaved changes</Badge>}
        {errors.length > 0 && <Badge tone="red">{errors.length} to fix</Badge>}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ApprovalBar
            status={draft.status}
            approvalState={draft.approval.state}
            onAction={async (action) => {
              const user = localStorage.getItem('flowcase.user') ?? undefined;
              const updated = await api.approval(draft.id, action, user);
              setDraft(updated as TestCase);
              testList.reload();
            }}
          />

          <Button
            onClick={async () => {
              if (dirty) {
                await save();
              }
              setExported(await api.exportTest(draft.id));
            }}
          >
            Export code
          </Button>
          <Button onClick={() => run(true)}>Preview</Button>
          <Button onClick={() => run(false)}>Run</Button>
          <Button variant="primary" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {saveError && <ErrorNote>{saveError}</ErrorNote>}

      <div className="flex gap-1 border-b border-line">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition ${
              tab === entry.id ? 'border-brand font-medium text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'steps' && (
        <StepList
          steps={draft.steps}
          issues={issues}
          dataSetNames={draft.dataSets.map((set) => set.name)}
          snippets={snippetList.map((snippet) => ({ id: snippet.id, name: snippet.name }))}
          onChange={setSteps}
        />
      )}

      {tab === 'settings' && (
        <SettingsTab
          test={draft}
          allTests={(testList.data?.tests ?? []).map((entry) => ({ id: entry.id, name: entry.name }))}
          environments={environments.data?.environments ?? []}
          sessions={[]}
          onChange={patch}
        />
      )}

      {tab === 'data' && <DataTab test={draft} onChange={patch} />}

      {tab === 'history' && <HistoryTab testId={draft.id} currentVersion={draft.version} />}

      {exported && (
        <Modal
          title={`Playwright spec — ${exported.filename}`}
          onClose={() => setExported(undefined)}
          wide
          footer={
            <>
              <Button onClick={() => void navigator.clipboard.writeText(exported.code)}>Copy</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const blob = new Blob([exported.code], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = exported.filename;
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download
              </Button>
            </>
          }
        >
          <p className="mb-2 text-xs text-muted">
            Plain <code>@playwright/test</code> — it runs without flowcase installed. Use it to hand a recorded
            flow to an engineer, or to keep a copy in your own repository.
          </p>
          <pre className="scroll-x rounded bg-canvas p-3 text-xs">{exported.code}</pre>
        </Modal>
      )}
    </div>
  );
}
