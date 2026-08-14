import type {
  Environment,
  ProjectConfig,
  Run,
  RunSummary,
  Schedule,
  Snippet,
  Step,
  StepDefinition,
  StepGroup,
  TestCase,
  ValidationIssue,
} from '@flowcase/core/model';

export interface ScheduleWithNext extends Schedule {
  nextRunAt?: string;
}

export interface TestWithIssues extends TestCase {
  issues: ValidationIssue[];
}

export interface TestListResponse {
  tests: TestWithIssues[];
  cycles: string[][];
  tags: string[];
}

export interface CatalogResponse {
  steps: StepDefinition[];
  groups: StepGroup[];
}

export interface PlanResponse {
  order: string[];
  requested: string[];
  added: string[];
  missing: string[];
  unapproved: string[];
  orderDetail: Array<{ id: string; name: string }>;
}

export interface RecorderStatus {
  recording: boolean;
  mode: 'record' | 'paused' | 'assert';
  stepCount: number;
  startUrl?: string;
}

export interface TestDiffResponse {
  from: number;
  to: number;
  diff: {
    fields: Array<{ field: string; label: string; before: string; after: string }>;
    steps: Array<{
      stepId: string;
      kind: 'added' | 'removed' | 'changed' | 'moved' | 'unchanged';
      label: string;
      previousLabel?: string;
      depth: number;
      changes: Array<{ field: string; label: string; before: string; after: string }>;
    }>;
    summary: { added: number; removed: number; changed: number; moved: number };
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(route, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed with status ${response.status}.`;

    throw new ApiError(response.status, message);
  }

  return payload as T;
}

export const api = {
  health: () => request<{ ok: boolean; projectDir: string }>('GET', '/api/health'),
  catalog: () => request<CatalogResponse>('GET', '/api/catalog'),

  config: () => request<ProjectConfig>('GET', '/api/config'),
  saveConfig: (config: Partial<ProjectConfig>) => request<ProjectConfig>('PUT', '/api/config', config),

  listTests: () => request<TestListResponse>('GET', '/api/tests'),
  getTest: (id: string) => request<TestWithIssues>('GET', `/api/tests/${id}`),
  createTest: (test: Partial<TestCase>) => request<TestCase>('POST', '/api/tests', test),
  saveTest: (id: string, test: Partial<TestCase>) => request<TestCase>('PUT', `/api/tests/${id}`, test),
  deleteTest: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/tests/${id}`),
  duplicateTest: (id: string) => request<TestCase>('POST', `/api/tests/${id}/duplicate`),
  testVersions: (id: string) => request<{ versions: number[] }>('GET', `/api/tests/${id}/versions`),
  testDiff: (id: string, from?: number, to?: number) => {
    const query = new URLSearchParams();
    if (from !== undefined) query.set('from', String(from));
    if (to !== undefined) query.set('to', String(to));
    return request<TestDiffResponse>('GET', `/api/tests/${id}/diff?${query.toString()}`);
  },
  approval: (id: string, action: 'request' | 'approve' | 'reject', user?: string, comment?: string) =>
    request<TestCase>('POST', `/api/tests/${id}/approval`, { action, user, comment }),
  dependents: (id: string) =>
    request<{ dependents: Array<{ id: string; name: string }> }>('GET', `/api/tests/${id}/dependents`),

  exportTest: (id: string) => request<{ filename: string; code: string }>('GET', `/api/tests/${id}/export`),

  listSchedules: () => request<{ schedules: ScheduleWithNext[] }>('GET', '/api/schedules'),
  createSchedule: (schedule: Partial<Schedule>) => request<Schedule>('POST', '/api/schedules', schedule),
  saveSchedule: (id: string, schedule: Partial<Schedule>) =>
    request<Schedule>('PUT', `/api/schedules/${id}`, schedule),
  deleteSchedule: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/schedules/${id}`),
  runSchedule: (id: string) => request<{ runId: string }>('POST', `/api/schedules/${id}/run`),

  listSnippets: () => request<{ snippets: Snippet[] }>('GET', '/api/snippets'),
  createSnippet: (snippet: Partial<Snippet>) => request<Snippet>('POST', '/api/snippets', snippet),
  saveSnippet: (id: string, snippet: Partial<Snippet>) => request<Snippet>('PUT', `/api/snippets/${id}`, snippet),
  deleteSnippet: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/snippets/${id}`),

  listEnvironments: () => request<{ environments: Environment[] }>('GET', '/api/environments'),
  createEnvironment: (environment: Partial<Environment>) =>
    request<Environment>('POST', '/api/environments', environment),
  saveEnvironment: (id: string, environment: Partial<Environment>) =>
    request<Environment>('PUT', `/api/environments/${id}`, environment),
  deleteEnvironment: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/environments/${id}`),

  listRuns: () => request<{ runs: RunSummary[]; active: RunSummary[] }>('GET', '/api/runs'),
  getRun: (id: string) => request<Run & { active: boolean }>('GET', `/api/runs/${id}`),
  startRun: (body: {
    testIds?: string[];
    tags?: string[];
    environmentId?: string;
    dryRun?: boolean;
    headed?: boolean;
    concurrency?: number;
    variables?: Record<string, string>;
  }) => request<{ runId: string }>('POST', '/api/runs', body),
  abortRun: (id: string) => request<{ aborted: boolean }>('POST', `/api/runs/${id}/abort`),
  plan: (body: { testIds?: string[]; tags?: string[] }) => request<PlanResponse>('POST', '/api/plan', body),

  recorderStatus: () => request<RecorderStatus>('GET', '/api/recorder/status'),
  startRecorder: (body: { startUrl?: string; environmentId?: string; session?: string }) =>
    request<RecorderStatus>('POST', '/api/recorder/start', body),
  recorderMode: (mode: 'record' | 'paused') => request<RecorderStatus>('POST', '/api/recorder/mode', { mode }),
  stopRecorder: () => request<{ steps: Step[] }>('POST', '/api/recorder/stop'),
};

export function artifactUrl(runId: string, artifactPath: string): string {
  return `/artifacts/${runId}/${artifactPath}`;
}
