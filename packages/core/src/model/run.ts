import { z } from 'zod';
import { JsonValueSchema, TimestampSchema } from './common.js';

export const RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'aborted', 'skipped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = [
  'pending',
  'running',
  'passed',
  'failed',
  'soft-failed',
  'skipped',
  'healed',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ARTIFACT_KINDS = [
  'screenshot',
  'video',
  'trace',
  'console',
  'network',
  'diff',
  'baseline',
  'actual',
  'html',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ArtifactSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  /** Path relative to the run directory, so a run folder stays portable. */
  path: z.string(),
  label: z.string().optional(),
  contentType: z.string().optional(),
  bytes: z.number().int().optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

export const LogEntrySchema = z.object({
  at: TimestampSchema,
  level: z.enum(['debug', 'info', 'warn', 'error']),
  source: z.enum(['engine', 'console', 'network', 'page']),
  message: z.string(),
  detail: JsonValueSchema.optional(),
});

export type LogEntry = z.infer<typeof LogEntrySchema>;

export const StepErrorSchema = z.object({
  message: z.string(),
  /** Playwright's own error name, e.g. `TimeoutError`. */
  name: z.string().optional(),
  stack: z.string().optional(),
  /** Set when the failure is an assertion rather than an action error. */
  expected: z.string().optional(),
  actual: z.string().optional(),
});

export type StepError = z.infer<typeof StepErrorSchema>;

/** Recorded whenever the primary selector failed and a fallback matched instead. */
export const HealEventSchema = z.object({
  from: z.string(),
  to: z.string(),
  engine: z.string(),
  score: z.number(),
  /** Confidence that the healed element is the same one, 0–1. */
  confidence: z.number().min(0).max(1),
  /** True once a human accepts the healed selector as the new primary. */
  accepted: z.boolean().default(false),
});

export type HealEvent = z.infer<typeof HealEventSchema>;

export const StepResultSchema = z.object({
  stepId: z.string(),
  /** Position in the flattened execution order — stable for the UI to key on. */
  index: z.number().int(),
  kind: z.string(),
  label: z.string(),
  status: z.enum(STEP_STATUSES),
  /** Zero-based repeat iteration; absent for steps that ran once. */
  iteration: z.number().int().optional(),
  /** Depth in the group tree, so the report can indent nested steps. */
  depth: z.number().int().default(0),
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  durationMs: z.number().int().default(0),
  attempts: z.number().int().default(1),
  /** The selector that actually resolved the element. */
  usedSelector: z.string().optional(),
  healed: HealEventSchema.optional(),
  error: StepErrorSchema.optional(),
  artifacts: z.array(ArtifactSchema).default([]),
  extracted: z.record(z.string(), JsonValueSchema).default({}),
  logs: z.array(LogEntrySchema).default([]),
});

export type StepResult = z.infer<typeof StepResultSchema>;

export const TestResultSchema = z.object({
  testId: z.string(),
  testName: z.string(),
  testVersion: z.number().int(),
  status: z.enum(RUN_STATUSES),
  /** Set when this test ran as one row of a data-driven set. */
  dataRowIndex: z.number().int().optional(),
  dataRowLabel: z.string().optional(),
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  durationMs: z.number().int().default(0),
  steps: z.array(StepResultSchema).default([]),
  artifacts: z.array(ArtifactSchema).default([]),
  /** Variables visible at the end of this test, carried into dependants. */
  variables: z.record(z.string(), JsonValueSchema).default({}),
  /** Assertions that failed softly — the run continued but the test is not clean. */
  softFailures: z.array(z.object({ stepId: z.string(), label: z.string(), message: z.string() })).default([]),
  error: z.string().optional(),
  /** Why the test was skipped, e.g. an unmet dependency. */
  skipReason: z.string().optional(),
});

export type TestResult = z.infer<typeof TestResultSchema>;

export const RUN_TRIGGERS = ['ui', 'cli', 'schedule', 'api'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RunSchema = z.object({
  id: z.string(),
  /** Tests the user asked for, before dependency expansion. */
  requestedTestIds: z.array(z.string()).default([]),
  /** Full execution order after resolving the dependency graph. */
  plan: z.array(z.string()).default([]),
  status: z.enum(RUN_STATUSES),
  environmentId: z.string().optional(),
  environmentName: z.string().optional(),
  dryRun: z.boolean().default(false),
  /** Number of tests executed concurrently. */
  concurrency: z.number().int().min(1).default(1),
  triggeredBy: z.enum(RUN_TRIGGERS).default('ui'),
  triggeredByUser: z.string().optional(),
  tagFilter: z.array(z.string()).default([]),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  durationMs: z.number().int().default(0),
  results: z.array(TestResultSchema).default([]),
  /** Run-scoped variables at the end of the run. */
  variables: z.record(z.string(), JsonValueSchema).default({}),
  error: z.string().optional(),
});

export type Run = z.infer<typeof RunSchema>;

/**
 * One line of `runs/index.ndjson`. Listing runs reads only this file, which keeps
 * the history view fast without a database.
 */
export const RunSummarySchema = z.object({
  id: z.string(),
  status: z.enum(RUN_STATUSES),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  durationMs: z.number().int().default(0),
  testIds: z.array(z.string()).default([]),
  testNames: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  environmentName: z.string().optional(),
  triggeredBy: z.enum(RUN_TRIGGERS).default('ui'),
  dryRun: z.boolean().default(false),
  passed: z.number().int().default(0),
  failed: z.number().int().default(0),
  skipped: z.number().int().default(0),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;

export function summarizeRun(run: Run): RunSummary {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    durationMs: run.durationMs,
    testIds: run.results.map((result) => result.testId),
    testNames: run.results.map((result) => result.testName),
    tags: [],
    ...(run.environmentName === undefined ? {} : { environmentName: run.environmentName }),
    triggeredBy: run.triggeredBy,
    dryRun: run.dryRun,
    passed: run.results.filter((result) => result.status === 'passed').length,
    failed: run.results.filter((result) => result.status === 'failed').length,
    skipped: run.results.filter((result) => result.status === 'skipped').length,
  };
}
