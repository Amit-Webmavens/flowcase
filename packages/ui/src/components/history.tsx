import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { TestDiffResponse } from '../api.js';
import { Badge, Button, Card, Field, Loading, Select } from '../ui.js';

const KIND_STYLE: Record<string, { tone: 'green' | 'red' | 'amber' | 'blue' | 'neutral'; label: string }> = {
  added: { tone: 'green', label: 'added' },
  removed: { tone: 'red', label: 'removed' },
  changed: { tone: 'amber', label: 'changed' },
  moved: { tone: 'blue', label: 'moved' },
  unchanged: { tone: 'neutral', label: 'unchanged' },
};

/**
 * Version history and diff.
 *
 * Every save that changes a test's content archives the previous version, so a
 * reviewer can see exactly what a tester altered before approving it.
 */
export function HistoryTab({ testId, currentVersion }: { testId: string; currentVersion: number }) {
  const [versions, setVersions] = useState<number[]>([]);
  const [from, setFrom] = useState<number>();
  const [to, setTo] = useState<number>();
  const [diff, setDiff] = useState<TestDiffResponse>();
  const [loading, setLoading] = useState(true);
  const [showUnchanged, setShowUnchanged] = useState(false);

  useEffect(() => {
    void api.testVersions(testId).then((response) => {
      setVersions(response.versions);
      setTo(response.versions[0] ?? currentVersion);
      setFrom(response.versions[1] ?? response.versions[0] ?? currentVersion);
      setLoading(false);
    });
  }, [testId, currentVersion]);

  useEffect(() => {
    if (from === undefined || to === undefined) {
      return;
    }

    void api
      .testDiff(testId, from, to)
      .then(setDiff)
      .catch(() => setDiff(undefined));
  }, [testId, from, to]);

  if (loading) {
    return <Loading />;
  }

  if (versions.length < 2) {
    return (
      <Card className="p-4 text-sm text-muted">
        This test only has one version so far. Every edit that changes its content keeps the previous version
        here for comparison.
      </Card>
    );
  }

  const visibleSteps = (diff?.diff.steps ?? []).filter(
    (step) => showUnchanged || step.kind !== 'unchanged',
  );

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Compare from">
            <Select value={from ?? ''} onChange={(event) => setFrom(Number(event.target.value))}>
              {versions.map((version) => (
                <option key={version} value={version}>
                  v{version}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="to">
            <Select value={to ?? ''} onChange={(event) => setTo(Number(event.target.value))}>
              {versions.map((version) => (
                <option key={version} value={version}>
                  v{version}
                </option>
              ))}
            </Select>
          </Field>

          {diff && (
            <div className="flex gap-1 pb-2">
              {diff.diff.summary.added > 0 && <Badge tone="green">+{diff.diff.summary.added} added</Badge>}
              {diff.diff.summary.removed > 0 && <Badge tone="red">−{diff.diff.summary.removed} removed</Badge>}
              {diff.diff.summary.changed > 0 && <Badge tone="amber">{diff.diff.summary.changed} changed</Badge>}
              {diff.diff.summary.moved > 0 && <Badge tone="blue">{diff.diff.summary.moved} moved</Badge>}
            </div>
          )}

          <label className="flex items-center gap-2 pb-2 text-xs">
            <input type="checkbox" checked={showUnchanged} onChange={(event) => setShowUnchanged(event.target.checked)} />
            Show unchanged steps
          </label>
        </div>
      </Card>

      {diff && diff.diff.fields.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-medium">Test settings</h3>
          <div className="flex flex-col gap-2">
            {diff.diff.fields.map((field) => (
              <div key={field.field} className="text-xs">
                <span className="font-medium">{field.label}</span>
                <div className="mt-0.5 flex flex-wrap gap-2">
                  <code className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-700 dark:text-red-300">
                    {field.before || '(empty)'}
                  </code>
                  <span className="text-muted">→</span>
                  <code className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
                    {field.after || '(empty)'}
                  </code>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-medium">Steps</h3>

        {visibleSteps.length === 0 ? (
          <p className="text-xs text-muted">No step changes between these versions.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {visibleSteps.map((step) => {
              const style = KIND_STYLE[step.kind] ?? KIND_STYLE.unchanged!;

              return (
                <div key={step.stepId} style={{ marginLeft: step.depth * 16 }} className="rounded border border-line px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Badge tone={style.tone}>{style.label}</Badge>
                    <span className="truncate text-xs">{step.label}</span>
                  </div>

                  {step.changes.length > 0 && (
                    <div className="mt-1 flex flex-col gap-0.5 pl-2">
                      {step.changes.map((change) => (
                        <div key={change.field} className="text-[11px]">
                          <span className="text-muted">{change.label}: </span>
                          <code className="rounded bg-red-500/10 px-1 text-red-700 dark:text-red-300">
                            {truncate(change.before) || '(empty)'}
                          </code>
                          <span className="text-muted"> → </span>
                          <code className="rounded bg-emerald-500/10 px-1 text-emerald-700 dark:text-emerald-300">
                            {truncate(change.after) || '(empty)'}
                          </code>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Approval controls, shown beside the diff so a reviewer decides with context. */
export function ApprovalBar({
  status,
  approvalState,
  onAction,
}: {
  status: string;
  approvalState: string;
  onAction: (action: 'request' | 'approve' | 'reject') => void;
}) {
  const [user, setUser] = useState(() => localStorage.getItem('flowcase.user') ?? '');

  const act = (action: 'request' | 'approve' | 'reject'): void => {
    localStorage.setItem('flowcase.user', user);
    onAction(action);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={status === 'approved' ? 'green' : status === 'in_review' ? 'amber' : 'neutral'}>
        {status.replace('_', ' ')}
      </Badge>

      <input
        value={user}
        placeholder="your name"
        onChange={(event) => setUser(event.target.value)}
        className="w-28 rounded-md border border-line bg-canvas px-2 py-1 text-xs"
      />

      {approvalState !== 'pending' && status !== 'approved' && (
        <Button size="sm" onClick={() => act('request')}>
          Request approval
        </Button>
      )}

      {approvalState === 'pending' && (
        <>
          <Button size="sm" variant="primary" onClick={() => act('approve')}>
            Approve
          </Button>
          <Button size="sm" variant="danger" onClick={() => act('reject')}>
            Request changes
          </Button>
        </>
      )}
    </div>
  );
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
