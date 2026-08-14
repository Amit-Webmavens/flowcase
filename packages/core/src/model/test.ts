import { z } from 'zod';
import { JsonValueSchema, TimestampSchema } from './common.js';
import { RetryPolicySchema, RouteMockSchema, StepSchema } from './step.js';

/** A declared input to a test or snippet. Rendered as a form field in the UI. */
export const VariableDefSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  type: z.enum(['string', 'number', 'boolean', 'secret', 'date']).default('string'),
  defaultValue: z.string().default(''),
  required: z.boolean().default(false),
  description: z.string().optional(),
  /**
   * `input`   — supplied when the run starts (or from the default).
   * `runtime` — produced by an extraction step; declared here for documentation.
   * `env`     — read from the active environment profile.
   */
  source: z.enum(['input', 'runtime', 'env']).default('input'),
});

export type VariableDef = z.infer<typeof VariableDefSchema>;

/** A named table of rows for data-driven runs and `repeat: data` blocks. */
export const DataSetSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  columns: z.array(z.string()).default([]),
  rows: z.array(z.record(z.string(), JsonValueSchema)).default([]),
});

export type DataSet = z.infer<typeof DataSetSchema>;

export const TEST_STATUSES = ['draft', 'in_review', 'approved', 'archived'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const ApprovalSchema = z.object({
  state: z.enum(['none', 'pending', 'approved', 'rejected']).default('none'),
  requestedBy: z.string().optional(),
  requestedAt: TimestampSchema.optional(),
  reviewedBy: z.string().optional(),
  reviewedAt: TimestampSchema.optional(),
  comment: z.string().optional(),
  /** Version the approval applies to. Edits after approval reset the state. */
  approvedVersion: z.number().int().optional(),
});

export type Approval = z.infer<typeof ApprovalSchema>;

export const AuthConfigSchema = z.object({
  /** Named saved session to load before the first step. */
  session: z.string().optional(),
  /** Reuse the session produced by a dependency instead of a saved file. */
  inheritFromDependency: z.boolean().default(true),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const TestCaseSchema = z.object({
  id: z.string(),
  /**
   * Required in practice, but not enforced here: the schema stays permissive so
   * a half-finished record still round-trips through storage, and `validateTest`
   * reports what is missing. That keeps the editor from rejecting a save with a
   * schema error while a tester is mid-edit.
   */
  name: z.string(),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),

  /** Ids of tests that must run first. Resolved into a DAG by the run planner. */
  dependsOn: z.array(z.string()).default([]),

  steps: z.array(StepSchema).default([]),
  variables: z.array(VariableDefSchema).default([]),
  dataSets: z.array(DataSetSchema).default([]),

  /**
   * When set, the test runs once per row of this data set and each run is
   * reported separately.
   */
  dataDrivenSet: z.string().optional(),

  /** Default environment; overridable per run. */
  environmentId: z.string().optional(),
  auth: AuthConfigSchema.default({ inheritFromDependency: true }),
  mocks: z.array(RouteMockSchema).default([]),

  /** Defaults inherited by steps that do not set their own. */
  defaultRetry: RetryPolicySchema.optional(),
  defaultTimeoutMs: z.number().int().min(0).max(600_000).default(15_000),

  status: z.enum(TEST_STATUSES).default('draft'),
  approval: ApprovalSchema.default({ state: 'none' }),

  /** Incremented on every save; every prior version is kept for the diff view. */
  version: z.number().int().min(1).default(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
});

export type TestCase = z.infer<typeof TestCaseSchema>;

/** A reusable fragment. Inlined wherever a `snippet` step references it. */
export const SnippetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  steps: z.array(StepSchema).default([]),
  /** Arguments bound when the snippet is inlined; referenced as `{{name}}` inside. */
  parameters: z.array(VariableDefSchema).default([]),
  version: z.number().int().min(1).default(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type Snippet = z.infer<typeof SnippetSchema>;

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  baseUrl: z.string().default(''),
  /** Plain values available as `{{name}}` in every step. */
  variables: z.record(z.string(), z.string()).default({}),
  /**
   * Secrets are never written to disk. Each entry maps a variable name to the
   * process environment variable holding the real value.
   */
  secretRefs: z.record(z.string(), z.string()).default({}),
  headless: z.boolean().default(true),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  viewport: z
    .object({ width: z.number().int().min(200), height: z.number().int().min(200) })
    .default({ width: 1280, height: 720 }),
  /** Extra HTTP headers applied to every request, e.g. a bypass token. */
  extraHttpHeaders: z.record(z.string(), z.string()).default({}),
  /** Ignore TLS errors — useful for staging with self-signed certificates. */
  ignoreHttpsErrors: z.boolean().default(false),
  locale: z.string().optional(),
  timezoneId: z.string().optional(),
  isDefault: z.boolean().default(false),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type Environment = z.infer<typeof EnvironmentSchema>;

/** Project-level configuration stored at `.flowcase/flowcase.json`. */
export const ProjectConfigSchema = z.object({
  name: z.string().default('flowcase project'),
  /** Schema version, so future releases can migrate stored JSON. */
  schemaVersion: z.number().int().min(1).default(1),
  defaultEnvironmentId: z.string().optional(),
  /** Attribute the recorder prefers when generating selectors. */
  testIdAttribute: z.string().default('data-testid'),
  /** Keep at most this many runs on disk; older run directories are pruned. */
  runRetention: z.number().int().min(1).default(200),
  /** Require approval before a test may run in CI. */
  requireApproval: z.boolean().default(false),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
