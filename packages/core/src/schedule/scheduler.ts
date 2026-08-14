import { nowIso } from '../model/common.js';
import type { Run } from '../model/run.js';
import type { ProjectStore } from '../storage/store.js';
import { startRun } from '../engine/runner.js';
import type { RunEventHandler } from '../engine/events.js';
import { matchesCron, parseCron } from './cron.js';
import type { CronFields } from './cron.js';
import { notify } from './notify.js';
import type { NotificationResult } from './notify.js';
import type { Schedule } from './model.js';

export interface SchedulerOptions {
  /** Base URL of the dashboard, so notifications can link to the run. */
  baseUrl?: string;
  /** How often to check for due schedules. Defaults to every 30 seconds. */
  tickMs?: number;
  onEvent?: RunEventHandler;
  onScheduleRun?: (schedule: Schedule, run: Run, notifications: NotificationResult[]) => void;
  onError?: (schedule: Schedule, error: Error) => void;
}

/**
 * Runs scheduled suites in-process while the server is up.
 *
 * A schedule fires at most once per minute: after triggering, `lastRunAt` is
 * stamped and used to suppress a second fire inside the same minute, which keeps
 * a short tick interval from launching duplicate runs.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: ProjectStore,
    private readonly options: SchedulerOptions = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    const tickMs = this.options.tickMs ?? 30_000;
    this.timer = setInterval(() => void this.tick(), tickMs);

    // Don't hold the process open just to poll for schedules.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Checks every schedule and runs the ones that are due. */
  async tick(at: Date = new Date()): Promise<string[]> {
    const schedules = await this.store.listSchedules();
    const triggered: string[] = [];

    for (const schedule of schedules) {
      if (!schedule.enabled || this.inFlight.has(schedule.id)) {
        continue;
      }

      let fields: CronFields;

      try {
        fields = parseCron(schedule.cron);
      } catch (error) {
        this.options.onError?.(schedule, error instanceof Error ? error : new Error(String(error)));
        continue;
      }

      if (!matchesCron(fields, at) || this.alreadyRanThisMinute(schedule, at)) {
        continue;
      }

      triggered.push(schedule.id);
      void this.execute(schedule);
    }

    return triggered;
  }

  /** Runs a schedule immediately, ignoring its cron expression. */
  async runNow(scheduleId: string): Promise<Run | undefined> {
    const schedule = await this.store.getSchedule(scheduleId);

    return schedule ? this.execute(schedule) : undefined;
  }

  private alreadyRanThisMinute(schedule: Schedule, at: Date): boolean {
    if (!schedule.lastRunAt) {
      return false;
    }

    return new Date(schedule.lastRunAt).toISOString().slice(0, 16) === at.toISOString().slice(0, 16);
  }

  private async execute(schedule: Schedule): Promise<Run | undefined> {
    this.inFlight.add(schedule.id);

    // Stamp before running so a long suite cannot be started twice by a later tick.
    await this.store
      .saveSchedule({ ...schedule, lastRunAt: nowIso(), lastStatus: 'running' })
      .catch(() => undefined);

    try {
      const run = await startRun({
        store: this.store,
        testIds: schedule.testIds,
        tags: schedule.tags,
        ...(schedule.environmentId === undefined ? {} : { environmentId: schedule.environmentId }),
        concurrency: schedule.concurrency,
        approvedOnly: schedule.approvedOnly,
        triggeredBy: 'schedule',
        triggeredByUser: schedule.name,
        ...(this.options.onEvent === undefined ? {} : { onEvent: this.options.onEvent }),
      });

      const notifications = await notify(schedule, run, {
        ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl }),
      });

      const latest = (await this.store.getSchedule(schedule.id)) ?? schedule;
      await this.store.saveSchedule({
        ...latest,
        lastRunAt: nowIso(),
        lastRunId: run.id,
        lastStatus: run.status,
      });

      this.options.onScheduleRun?.(schedule, run, notifications);

      return run;
    } catch (error) {
      this.options.onError?.(schedule, error instanceof Error ? error : new Error(String(error)));

      const latest = (await this.store.getSchedule(schedule.id)) ?? schedule;
      await this.store
        .saveSchedule({ ...latest, lastStatus: 'error', lastRunAt: nowIso() })
        .catch(() => undefined);

      return undefined;
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }
}
