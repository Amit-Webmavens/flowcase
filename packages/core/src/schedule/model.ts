import { z } from 'zod';
import { TimestampSchema } from '../model/common.js';

/**
 * Where a schedule sends its report.
 *
 * `webhook` posts the full JSON summary; `slack` posts a formatted message to an
 * incoming-webhook URL. Email is deliberately not built in — every mail provider
 * has an HTTP endpoint, so pointing a webhook at it keeps this package free of
 * an SMTP dependency.
 */
export const NotificationChannelSchema = z.object({
  id: z.string(),
  kind: z.enum(['webhook', 'slack']),
  url: z.string(),
  /** Extra headers for `webhook`, e.g. an authorization token. */
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});

export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const ScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  /** Five-field cron, or a shorthand such as `@daily`. */
  cron: z.string().default('0 3 * * *'),

  /** What to run. Empty means everything matching `tags`. */
  testIds: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  environmentId: z.string().optional(),
  concurrency: z.number().int().min(1).max(16).default(1),
  approvedOnly: z.boolean().default(false),

  notify: z.array(NotificationChannelSchema).default([]),
  /** Notify on every run, or only when something fails. */
  notifyOn: z.enum(['failure', 'always']).default('failure'),

  lastRunAt: TimestampSchema.optional(),
  lastRunId: z.string().optional(),
  lastStatus: z.string().optional(),

  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type Schedule = z.infer<typeof ScheduleSchema>;
