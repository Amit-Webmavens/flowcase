import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NotificationChannel, Schedule } from '@flowcase/core/model';
import { describeCron } from '@flowcase/core/model';
import { api } from '../api.js';
import type { ScheduleWithNext } from '../api.js';
import { formatWhen, useAsync } from '../hooks.js';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Loading, Select, statusTone } from '../ui.js';

const PRESETS = [
  { label: 'Every hour', cron: '@hourly' },
  { label: 'Every night at 3am', cron: '0 3 * * *' },
  { label: 'Weekday mornings at 8am', cron: '0 8 * * 1-5' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Monday mornings', cron: '0 9 * * 1' },
];

/**
 * Scheduled suites and where their results go. Notifications are sent on failure
 * by default, so a green run stays quiet.
 */
export function SchedulesPage() {
  const navigate = useNavigate();
  const schedules = useAsync(() => api.listSchedules(), []);
  const tests = useAsync(() => api.listTests(), []);
  const environments = useAsync(() => api.listEnvironments(), []);
  const [editing, setEditing] = useState<Schedule>();
  const [error, setError] = useState<string>();

  const create = async (): Promise<void> => {
    const created = await api.createSchedule({ name: 'Nightly run', cron: '0 3 * * *' });
    schedules.reload();
    setEditing(created);
  };

  const save = async (): Promise<void> => {
    if (!editing) {
      return;
    }

    try {
      await api.saveSchedule(editing.id, editing);
      setEditing(undefined);
      setError(undefined);
      schedules.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  if (schedules.loading) {
    return <Loading />;
  }

  const list = schedules.data?.schedules ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Schedules</h1>
        <Button className="ml-auto" onClick={create}>
          + New schedule
        </Button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {list.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          description="Run a suite on a timer and get a message when something breaks. Schedules run while the flowcase server is up."
          action={<Button variant="primary" onClick={create}>Create a schedule</Button>}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((schedule) => (
            <Card key={schedule.id} className="p-4">
              {editing?.id === schedule.id ? (
                <ScheduleForm
                  schedule={editing}
                  tests={(tests.data?.tests ?? []).map((test) => ({ id: test.id, name: test.name }))}
                  tags={tests.data?.tags ?? []}
                  environments={(environments.data?.environments ?? []).map((environment) => ({
                    id: environment.id,
                    name: environment.name,
                  }))}
                  onChange={setEditing}
                  onSave={save}
                  onCancel={() => setEditing(undefined)}
                />
              ) : (
                <ScheduleRow
                  schedule={schedule}
                  onEdit={() => setEditing(schedule)}
                  onRunNow={async () => {
                    const { runId } = await api.runSchedule(schedule.id);
                    navigate(`/runs/${runId}`);
                  }}
                  onToggle={async () => {
                    await api.saveSchedule(schedule.id, { ...schedule, enabled: !schedule.enabled });
                    schedules.reload();
                  }}
                  onDelete={async () => {
                    if (window.confirm(`Delete schedule "${schedule.name}"?`)) {
                      await api.deleteSchedule(schedule.id);
                      schedules.reload();
                    }
                  }}
                />
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleRow({
  schedule,
  onEdit,
  onRunNow,
  onToggle,
  onDelete,
}: {
  schedule: ScheduleWithNext;
  onEdit: () => void;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{schedule.name}</span>
      <Badge tone={schedule.enabled ? 'green' : 'neutral'}>{schedule.enabled ? 'on' : 'paused'}</Badge>
      <code className="rounded bg-canvas px-1.5 py-0.5 text-xs">{schedule.cron}</code>

      <span className="text-xs text-muted">
        {schedule.nextRunAt ? `next ${formatWhen(schedule.nextRunAt)}` : describeCron(schedule.cron)}
      </span>

      {schedule.lastStatus && (
        <Badge tone={statusTone(schedule.lastStatus)}>last: {schedule.lastStatus}</Badge>
      )}

      <span className="text-xs text-muted">
        {schedule.testIds.length > 0
          ? `${schedule.testIds.length} test(s)`
          : schedule.tags.length > 0
            ? `tags: ${schedule.tags.join(', ')}`
            : 'all tests'}
      </span>

      <span className="text-xs text-muted">
        {schedule.notify.length} notification{schedule.notify.length === 1 ? '' : 's'}
      </span>

      <div className="ml-auto flex gap-2">
        <Button size="sm" onClick={onRunNow}>
          Run now
        </Button>
        <Button size="sm" onClick={onToggle}>
          {schedule.enabled ? 'Pause' : 'Resume'}
        </Button>
        <Button size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="danger" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function ScheduleForm({
  schedule,
  tests,
  tags,
  environments,
  onChange,
  onSave,
  onCancel,
}: {
  schedule: Schedule;
  tests: Array<{ id: string; name: string }>;
  tags: string[];
  environments: Array<{ id: string; name: string }>;
  onChange: (schedule: Schedule) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<Schedule>): void => onChange({ ...schedule, ...patch });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={schedule.name} onChange={(event) => set({ name: event.target.value })} />
        </Field>

        <Field label="When" hint={describeCron(schedule.cron)}>
          <div className="flex gap-2">
            <Input value={schedule.cron} onChange={(event) => set({ cron: event.target.value })} />
            <Select value="" onChange={(event) => event.target.value && set({ cron: event.target.value })}>
              <option value="">Presets…</option>
              {PRESETS.map((preset) => (
                <option key={preset.cron} value={preset.cron}>
                  {preset.label}
                </option>
              ))}
            </Select>
          </div>
        </Field>

        <Field label="Environment">
          <Select
            value={schedule.environmentId ?? ''}
            onChange={(event) => set({ environmentId: event.target.value || undefined })}
          >
            <option value="">Project default</option>
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Tests to run at once" hint="Independent tests only; dependencies always run in order.">
          <Input
            type="number"
            min={1}
            max={16}
            value={schedule.concurrency}
            onChange={(event) => set({ concurrency: Number(event.target.value) })}
          />
        </Field>
      </div>

      <div>
        <p className="mb-1 text-xs font-medium text-muted">What to run</p>
        <p className="mb-2 text-[11px] text-muted">
          Pick tests, or filter by tag. Leave both empty to run everything.
        </p>

        <div className="mb-2 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() =>
                set({
                  tags: schedule.tags.includes(tag)
                    ? schedule.tags.filter((value) => value !== tag)
                    : [...schedule.tags, tag],
                })
              }
              className={`rounded border px-1.5 py-0.5 text-[11px] ${
                schedule.tags.includes(tag) ? 'border-brand bg-brand/10 text-brand' : 'border-line text-muted'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>

        <div className="max-h-40 overflow-y-auto rounded border border-line p-2">
          {tests.map((test) => (
            <label key={test.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={schedule.testIds.includes(test.id)}
                onChange={(event) =>
                  set({
                    testIds: event.target.checked
                      ? [...schedule.testIds, test.id]
                      : schedule.testIds.filter((id) => id !== test.id),
                  })
                }
              />
              {test.name}
            </label>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={schedule.approvedOnly}
          onChange={(event) => set({ approvedOnly: event.target.checked })}
        />
        Only run tests that have been approved
      </label>

      <NotificationEditor
        channels={schedule.notify}
        notifyOn={schedule.notifyOn}
        onChange={(notify) => set({ notify })}
        onNotifyOnChange={(notifyOn) => set({ notifyOn })}
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

function NotificationEditor({
  channels,
  notifyOn,
  onChange,
  onNotifyOnChange,
}: {
  channels: NotificationChannel[];
  notifyOn: 'failure' | 'always';
  onChange: (channels: NotificationChannel[]) => void;
  onNotifyOnChange: (value: 'failure' | 'always') => void;
}) {
  const update = (index: number, patch: Partial<NotificationChannel>): void =>
    onChange(channels.map((channel, position) => (position === index ? { ...channel, ...patch } : channel)));

  return (
    <div className="rounded-md border border-line p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium">Notifications</span>
        <Button
          size="sm"
          onClick={() =>
            onChange([
              ...channels,
              {
                id: `ch_${Math.random().toString(36).slice(2, 9)}`,
                kind: 'slack',
                url: '',
                headers: {},
                enabled: true,
              },
            ])
          }
        >
          + Add
        </Button>
      </div>

      <Field label="Send a message">
        <Select value={notifyOn} onChange={(event) => onNotifyOnChange(event.target.value as 'failure' | 'always')}>
          <option value="failure">Only when something fails</option>
          <option value="always">After every run</option>
        </Select>
      </Field>

      <div className="mt-2 flex flex-col gap-2">
        {channels.map((channel, index) => (
          <div key={channel.id} className="flex flex-wrap items-center gap-2">
            <Select
              value={channel.kind}
              className="max-w-32"
              onChange={(event) => update(index, { kind: event.target.value as NotificationChannel['kind'] })}
            >
              <option value="slack">Slack</option>
              <option value="webhook">Webhook</option>
            </Select>

            <Input
              value={channel.url}
              placeholder={channel.kind === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://example.com/hook'}
              className="flex-1"
              onChange={(event) => update(index, { url: event.target.value })}
            />

            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={channel.enabled}
                onChange={(event) => update(index, { enabled: event.target.checked })}
              />
              on
            </label>

            <Button
              size="sm"
              variant="danger"
              onClick={() => onChange(channels.filter((_, position) => position !== index))}
            >
              ✕
            </Button>
          </div>
        ))}

        {channels.length === 0 && (
          <p className="text-[11px] text-muted">
            No notifications yet. Slack takes an incoming-webhook URL; a plain webhook receives the full run
            summary as JSON, which most email services accept too.
          </p>
        )}
      </div>
    </div>
  );
}
