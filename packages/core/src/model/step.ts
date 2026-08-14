import { z } from 'zod';
import { JsonValueSchema } from './common.js';
import { TargetSchema } from './selector.js';

/**
 * Every action the engine can perform. Kept as a flat enum rather than a
 * discriminated union: the no-code editor builds steps incrementally, so a step
 * must stay representable while it is still missing fields. Per-kind field
 * requirements live in the step catalog and are checked by `validateStep`.
 */
export const STEP_KINDS = [
  // Navigation
  'goto',
  'reload',
  'goBack',
  'goForward',
  'setViewport',
  // Interaction
  'click',
  'dblclick',
  'rightClick',
  'fill',
  'type',
  'press',
  'select',
  'check',
  'uncheck',
  'hover',
  'focus',
  'clear',
  'upload',
  'dragAndDrop',
  'scrollTo',
  // Waiting
  'waitForSelector',
  'waitForHidden',
  'waitForUrl',
  'waitForText',
  'waitForTimeout',
  'waitForResponse',
  'waitForLoadState',
  // Assertions
  'assertVisible',
  'assertHidden',
  'assertText',
  'assertValue',
  'assertUrl',
  'assertTitle',
  'assertCount',
  'assertAttribute',
  'assertChecked',
  'assertEnabled',
  'assertDisabled',
  // Data
  'extract',
  'setVariable',
  // Composition
  'group',
  'snippet',
  // Utility
  'screenshot',
  'visualCheck',
  'mockRoute',
  'unmockRoute',
  'saveSession',
  'loadSession',
  'comment',
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

/** How a step failure affects the rest of the run. */
export const FAILURE_MODES = ['fail', 'soft', 'ignore'] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export const RetryPolicySchema = z.object({
  /** Total attempts including the first. 1 means no retry. */
  attempts: z.number().int().min(1).max(20).default(1),
  delayMs: z.number().int().min(0).max(120_000).default(500),
  backoff: z.enum(['fixed', 'linear', 'exponential']).default('fixed'),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * Repeat modes:
 * - `fixed`    — run the step N times.
 * - `variable` — run it as many times as a runtime variable says (capped by `max`).
 * - `data`     — run once per row of a named data set, exposing the row as a variable.
 * - `while`    — run until an element appears/disappears, capped by `max`.
 */
export const RepeatPolicySchema = z.object({
  mode: z.enum(['fixed', 'variable', 'data', 'while']).default('fixed'),
  count: z.number().int().min(0).max(10_000).optional(),
  countVariable: z.string().optional(),
  dataSet: z.string().optional(),
  condition: z.enum(['visible', 'hidden']).optional(),
  conditionTarget: TargetSchema.optional(),
  /** Hard ceiling for `variable` and `while` modes so a bad value cannot hang a run. */
  max: z.number().int().min(1).max(10_000).default(100),
  /** Variable name exposing the zero-based iteration number. */
  indexVariable: z.string().default('_index'),
  /** Variable name exposing the current data row in `data` mode. */
  itemVariable: z.string().default('row'),
  /** Stop repeating on the first failed iteration instead of continuing. */
  stopOnFailure: z.boolean().default(true),
});

export type RepeatPolicy = z.infer<typeof RepeatPolicySchema>;

/** Where a runtime value is read from. */
export const EXTRACT_SOURCES = [
  'url',
  'text',
  'attribute',
  'inputValue',
  'title',
  'response',
  'storage',
  'count',
  'literal',
] as const;

export type ExtractSource = (typeof EXTRACT_SOURCES)[number];

export const ExtractionRuleSchema = z.object({
  /** Variable name the extracted value is bound to. */
  name: z.string(),
  from: z.enum(EXTRACT_SOURCES),
  target: TargetSchema.optional(),
  attribute: z.string().optional(),
  /** For `from: 'response'` — glob or regex matched against the request URL. */
  urlPattern: z.string().optional(),
  /** Dot/bracket path into a JSON response body, e.g. `data.order.id`. */
  jsonPath: z.string().optional(),
  /** Regex applied to the raw string; `group` selects the capture group. */
  pattern: z.string().optional(),
  group: z.number().int().min(0).default(1),
  storageKey: z.string().optional(),
  storageType: z.enum(['local', 'session', 'cookie']).optional(),
  literal: z.string().optional(),
  /**
   * `run` keeps the value available to downstream chained tests;
   * `test` confines it to the current test.
   */
  scope: z.enum(['run', 'test']).default('run'),
  /** When true, a missing value fails the step. */
  required: z.boolean().default(true),
});

export type ExtractionRule = z.infer<typeof ExtractionRuleSchema>;

/** A network stub. Applied for the whole test, or toggled mid-test via mockRoute steps. */
export const RouteMockSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  /** Glob (`**\/api/orders`) or `re:`-prefixed regex matched against the request URL. */
  urlPattern: z.string(),
  method: z.enum(['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('ANY'),
  status: z.number().int().min(100).max(599).default(200),
  contentType: z.string().default('application/json'),
  body: z.string().default(''),
  headers: z.record(z.string(), z.string()).default({}),
  delayMs: z.number().int().min(0).max(60_000).default(0),
  /** Serve the stub this many times, then fall through to the network. 0 = always. */
  times: z.number().int().min(0).default(0),
  /** When true the request is aborted instead of fulfilled. */
  abort: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export type RouteMock = z.infer<typeof RouteMockSchema>;

export const VisualCheckSchema = z.object({
  /** Baseline name; defaults to the step id when omitted. */
  name: z.string().optional(),
  /** Allowed fraction of differing pixels, 0–1. */
  threshold: z.number().min(0).max(1).default(0.01),
  /** Per-pixel colour sensitivity passed to pixelmatch, 0–1. */
  pixelThreshold: z.number().min(0).max(1).default(0.1),
  /** Selectors masked out before comparison — timestamps, avatars, ads. */
  mask: z.array(TargetSchema).default([]),
  fullPage: z.boolean().default(false),
  /** Create the baseline instead of comparing when one does not exist yet. */
  updateBaseline: z.boolean().default(false),
});

export type VisualCheck = z.infer<typeof VisualCheckSchema>;

/**
 * A single step. `children` (for `group`) is typed loosely here and refined by
 * `StepSchema` below, because zod needs the recursion declared after the fact.
 */
const StepBaseSchema = z.object({
  id: z.string(),
  kind: z.enum(STEP_KINDS),
  /** Human label shown in the editor and run report. Auto-generated when recorded. */
  label: z.string().default(''),
  /** Free-text annotation from a tester. Never affects execution. */
  note: z.string().optional(),
  enabled: z.boolean().default(true),

  target: TargetSchema.optional(),
  /** Primary operand. Supports `{{variable}}` interpolation for every kind. */
  value: z.string().optional(),
  /** Secondary operand: drag target, attribute name, expected count, and so on. */
  value2: z.string().optional(),
  /** File paths for `upload`, relative to the project directory. */
  files: z.array(z.string()).default([]),

  timeoutMs: z.number().int().min(0).max(600_000).optional(),
  retry: RetryPolicySchema.optional(),
  repeat: RepeatPolicySchema.optional(),
  onFailure: z.enum(FAILURE_MODES).default('fail'),

  /** Values pulled out of the page after the step succeeds. */
  extract: z.array(ExtractionRuleSchema).default([]),

  /** For `assertText`-style kinds: how the expected value is compared. */
  matcher: z
    .enum(['equals', 'contains', 'startsWith', 'endsWith', 'regex', 'notContains'])
    .default('contains'),

  /** For `mockRoute`. */
  mock: RouteMockSchema.optional(),
  /** For `visualCheck`. */
  visual: VisualCheckSchema.optional(),
  /** For `snippet` — which fragment to inline, and the arguments bound to it. */
  snippetId: z.string().optional(),
  snippetArgs: z.record(z.string(), JsonValueSchema).default({}),
});

export type Step = z.infer<typeof StepBaseSchema> & { children: Step[] };

export const StepSchema: z.ZodType<Step> = StepBaseSchema.extend({
  /** Nested steps for `group`. Enables repeating or disabling a whole block at once. */
  children: z.lazy(() => z.array(StepSchema)).default([]),
}) as z.ZodType<Step>;

/** Walks a step tree depth-first, including the roots themselves. */
export function* walkSteps(steps: Step[]): Generator<Step> {
  for (const step of steps) {
    yield step;
    if (step.children.length > 0) {
      yield* walkSteps(step.children);
    }
  }
}

export function findStep(steps: Step[], stepId: string): Step | undefined {
  for (const step of walkSteps(steps)) {
    if (step.id === stepId) {
      return step;
    }
  }

  return undefined;
}
