import type { Run } from '../model/run.js';
import type { NotificationChannel, Schedule } from './model.js';

export interface NotificationResult {
  channelId: string;
  ok: boolean;
  error?: string;
}

/**
 * Sends the outcome of a scheduled run.
 *
 * Delivery failures are reported, never thrown: a broken webhook must not turn a
 * passing suite into an error, and the result is recorded so the UI can show
 * that a notification did not get through.
 */
export async function notify(
  schedule: Schedule,
  run: Run,
  options: { baseUrl?: string } = {},
): Promise<NotificationResult[]> {
  const failed = run.results.filter((result) => result.status === 'failed');

  if (schedule.notifyOn === 'failure' && failed.length === 0) {
    return [];
  }

  const results: NotificationResult[] = [];

  for (const channel of schedule.notify) {
    if (!channel.enabled || channel.url.trim().length === 0) {
      continue;
    }

    try {
      await deliver(channel, schedule, run, options.baseUrl);
      results.push({ channelId: channel.id, ok: true });
    } catch (error) {
      results.push({
        channelId: channel.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function deliver(
  channel: NotificationChannel,
  schedule: Schedule,
  run: Run,
  baseUrl: string | undefined,
): Promise<void> {
  const body = channel.kind === 'slack' ? slackPayload(schedule, run, baseUrl) : webhookPayload(schedule, run, baseUrl);

  const response = await fetch(channel.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...channel.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`${channel.kind} returned ${response.status} ${response.statusText}`);
  }
}

function counts(run: Run): { passed: number; failed: number; skipped: number } {
  return {
    passed: run.results.filter((result) => result.status === 'passed').length,
    failed: run.results.filter((result) => result.status === 'failed').length,
    skipped: run.results.filter((result) => result.status === 'skipped').length,
  };
}

function webhookPayload(schedule: Schedule, run: Run, baseUrl: string | undefined): unknown {
  const summary = counts(run);

  return {
    schedule: { id: schedule.id, name: schedule.name },
    run: {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      environment: run.environmentName,
      url: baseUrl ? `${baseUrl}/runs/${run.id}` : undefined,
      ...summary,
    },
    failures: run.results
      .filter((result) => result.status === 'failed')
      .map((result) => ({
        test: result.testName,
        error: result.error,
        failedStep: result.steps.find((step) => step.status === 'failed')?.label,
      })),
  };
}

function slackPayload(schedule: Schedule, run: Run, baseUrl: string | undefined): unknown {
  const summary = counts(run);
  const icon = summary.failed > 0 ? ':x:' : ':white_check_mark:';
  const link = baseUrl ? ` <${baseUrl}/runs/${run.id}|View the run>` : '';

  const lines = [
    `${icon} *${schedule.name}* — ${summary.failed > 0 ? 'failures' : 'all passed'}`,
    `${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped · ${(run.durationMs / 1000).toFixed(1)}s${link}`,
  ];

  for (const result of run.results.filter((entry) => entry.status === 'failed').slice(0, 10)) {
    const step = result.steps.find((entry) => entry.status === 'failed');
    lines.push(`• *${result.testName}* — ${step?.label ?? result.error ?? 'failed'}`);
  }

  return { text: lines.join('\n') };
}
