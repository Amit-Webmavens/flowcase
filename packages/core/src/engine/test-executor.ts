import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { JsonValue } from '../model/common.js';
import { nowIso } from '../model/common.js';
import { summarizeStep } from '../model/catalog.js';
import type { Artifact, LogEntry, StepError, StepResult, TestResult } from '../model/run.js';
import type { Step } from '../model/step.js';
import type { Environment, Snippet, TestCase } from '../model/test.js';
import { locatorFor } from '../selectors/resolve.js';
import { TargetResolutionError } from '../selectors/resolve.js';
import { ensureDir } from '../storage/fs-utils.js';
import type { ProjectStore } from '../storage/store.js';
import type { CapturedResponse } from '../variables/extract.js';
import { interpolate, resolveTyped } from '../variables/interpolate.js';
import { VariableScope } from '../variables/scope.js';
import type { RunEvent } from './events.js';
import { inlineSnippets } from './inline.js';
import { MockRegistry } from './mocks.js';
import { AssertionFailure, executeStep } from './step-executor.js';
import type { StepContext } from './step-executor.js';

export interface DataRow {
  index: number;
  values: Record<string, JsonValue>;
  label: string;
}

export interface ExecuteTestOptions {
  test: TestCase;
  snippets: Map<string, Snippet>;
  page: Page;
  browserContext: BrowserContext;
  store: ProjectStore;
  environment: Environment | undefined;
  /** Run-level scope; the test gets a child of it. */
  runScope: VariableScope;
  runId: string;
  /** Absolute path of the run directory. */
  runDir: string;
  dataRow?: DataRow;
  /** Ripple where the runner acts — set when the run is headed. */
  highlight?: boolean;
  emit: (event: RunEvent) => void;
  signal?: AbortSignal;
}

/** Thrown internally to unwind out of nested groups when a step fails hard. */
class AbortTest extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AbortTest';
  }
}

/**
 * Runs one test end to end and produces its result.
 *
 * Owns everything test-scoped: the variable scope, network capture, mocks, the
 * step tree (including groups and repeats), and the artifacts kept when
 * something fails — video, a screenshot of the failing step, a Playwright trace,
 * and the console/network log.
 */
export async function executeTest(options: ExecuteTestOptions): Promise<TestResult> {
  const { test, page, browserContext, store, environment, runScope, runDir, dataRow, emit, runId } = options;

  const startedAt = nowIso();
  const startedMs = Date.now();

  const suffix = dataRow ? `-row${dataRow.index + 1}` : '';
  const artifactPrefix = `${test.id}${suffix}`;
  const artifactDir = path.join(runDir, artifactPrefix);
  await ensureDir(artifactDir);

  const logs: LogEntry[] = [];
  const responses: CapturedResponse[] = [];
  const steps: StepResult[] = [];
  const softFailures: TestResult['softFailures'] = [];
  const testArtifacts: Artifact[] = [];

  const log = (entry: LogEntry): void => {
    logs.push(entry);
    emit({ type: 'log', runId, testId: test.id, entry });
  };

  const scope = buildTestScope(test, environment, runScope, dataRow);
  const mocks = new MockRegistry(page);

  attachPageListeners(page, log, responses);

  let tracingStarted = false;

  try {
    await browserContext.tracing.start({ screenshots: true, snapshots: true, title: test.name });
    tracingStarted = true;
  } catch {
    // Tracing is chromium-only in some setups; its absence must not fail a run.
  }

  let status: TestResult['status'] = 'passed';
  let error: string | undefined;

  const context: StepContext = {
    page,
    scope,
    responses,
    mocks,
    store,
    test,
    environment,
    artifactDir,
    artifactPrefix,
    defaultTimeoutMs: test.defaultTimeoutMs,
    highlight: options.highlight ?? false,
    log,
  };

  try {
    for (const mock of test.mocks) {
      await mocks.apply(mock, scope);
    }

    const executable = inlineSnippets(test.steps, options.snippets);
    await runStepList(executable, 0, scope, {
      ...options,
      context,
      steps,
      softFailures,
      log,
    });

    if (softFailures.length > 0) {
      status = 'failed';
      error = `${softFailures.length} soft assertion${softFailures.length === 1 ? '' : 's'} failed.`;
    }
  } catch (caught) {
    status = caught instanceof AbortTest ? 'failed' : 'failed';
    error = caught instanceof Error ? caught.message : String(caught);
  }

  // ── Failure artifacts ────────────────────────────────────────────────────
  if (tracingStarted) {
    if (status === 'failed') {
      const tracePath = path.join(artifactDir, 'trace.zip');
      await browserContext.tracing.stop({ path: tracePath }).catch(() => undefined);
      testArtifacts.push({
        kind: 'trace',
        path: path.posix.join(artifactPrefix, 'trace.zip'),
        label: 'Playwright trace',
        contentType: 'application/zip',
      });
    } else {
      await browserContext.tracing.stop().catch(() => undefined);
    }
  }

  if (status === 'failed') {
    const logPath = path.join(artifactDir, 'log.json');
    await fs.writeFile(logPath, `${JSON.stringify(logs, null, 2)}\n`, 'utf8');
    testArtifacts.push({
      kind: 'console',
      path: path.posix.join(artifactPrefix, 'log.json'),
      label: 'Console and network log',
      contentType: 'application/json',
    });

    if (responses.length > 0) {
      const networkPath = path.join(artifactDir, 'network.json');
      await fs.writeFile(networkPath, `${JSON.stringify(responses, null, 2)}\n`, 'utf8');
      testArtifacts.push({
        kind: 'network',
        path: path.posix.join(artifactPrefix, 'network.json'),
        label: 'Network responses',
        contentType: 'application/json',
      });
    }
  }

  await mocks.removeAll().catch(() => undefined);

  const finishedAt = nowIso();

  return {
    testId: test.id,
    testName: test.name,
    testVersion: test.version,
    status,
    ...(dataRow ? { dataRowIndex: dataRow.index, dataRowLabel: dataRow.label } : {}),
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    steps,
    artifacts: testArtifacts,
    variables: scope.toObject(),
    softFailures,
    ...(error === undefined ? {} : { error }),
  };
}

interface RunListContext extends ExecuteTestOptions {
  context: StepContext;
  steps: StepResult[];
  softFailures: TestResult['softFailures'];
  log: (entry: LogEntry) => void;
}

/** Walks a step list, honouring enablement, repeats and nesting. */
async function runStepList(
  list: Step[],
  depth: number,
  scope: VariableScope,
  shared: RunListContext,
): Promise<void> {
  for (const step of list) {
    shared.signal?.throwIfAborted();

    if (!step.enabled) {
      shared.steps.push(baseResult(step, shared.steps.length, depth, 'skipped', labelFor(step, scope)));
      continue;
    }

    if (step.kind === 'comment') {
      shared.steps.push(baseResult(step, shared.steps.length, depth, 'passed', labelFor(step, scope)));
      continue;
    }

    await runStepWithRepeat(step, depth, scope, shared);
  }
}

async function runStepWithRepeat(
  step: Step,
  depth: number,
  scope: VariableScope,
  shared: RunListContext,
): Promise<void> {
  const repeat = step.repeat;

  if (!repeat) {
    await runSingleStep(step, depth, scope, shared, undefined);
    return;
  }

  const rows = repeat.mode === 'data' ? dataRowsFor(shared.test, repeat.dataSet) : undefined;
  const limit = resolveIterationLimit(step, scope, rows?.length);

  for (let iteration = 0; iteration < limit; iteration += 1) {
    shared.signal?.throwIfAborted();

    if (repeat.mode === 'while' && !(await conditionHolds(step, shared))) {
      break;
    }

    const iterationScope = scope.child();
    iterationScope.set(repeat.indexVariable, iteration);

    const row = rows?.[iteration];

    if (row) {
      iterationScope.set(repeat.itemVariable, row);

      // Row columns are also exposed directly, so `{{email}}` works alongside `{{row.email}}`.
      for (const [key, value] of Object.entries(row)) {
        iterationScope.set(key, value);
      }
    }

    const failed = await runSingleStep(step, depth, iterationScope, shared, iteration);

    if (failed && repeat.stopOnFailure) {
      break;
    }
  }
}

/** Returns true when the step failed (soft or ignored — hard failures throw). */
async function runSingleStep(
  step: Step,
  depth: number,
  scope: VariableScope,
  shared: RunListContext,
  iteration: number | undefined,
): Promise<boolean> {
  const index = shared.steps.length;
  const result = baseResult(step, index, depth, 'running', labelFor(step, scope));

  if (iteration !== undefined) {
    result.iteration = iteration;
  }

  result.startedAt = nowIso();
  const startedMs = Date.now();

  shared.steps.push(result);
  shared.emit({ type: 'step:start', runId: shared.runId, testId: shared.test.id, step: result });

  const finish = (): void => {
    result.finishedAt = nowIso();
    result.durationMs = Date.now() - startedMs;
    shared.emit({ type: 'step:end', runId: shared.runId, testId: shared.test.id, step: result });
  };

  // A group performs no action itself — it exists to scope its children.
  if (step.kind === 'group') {
    const groupScope = scope.child();

    for (const [name, value] of Object.entries(step.snippetArgs)) {
      groupScope.set(name, typeof value === 'string' ? resolveTyped(value, scope) : value);
    }

    result.status = 'passed';
    finish();

    await runStepList(step.children, depth + 1, groupScope, shared);
    return false;
  }

  const retry = step.retry ?? shared.test.defaultRetry;
  const attempts = Math.max(1, retry?.attempts ?? 1);

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result.attempts = attempt;

    try {
      const outcome = await executeStep(step, { ...shared.context, scope });

      result.status = outcome.heal ? 'healed' : 'passed';
      result.extracted = outcome.extracted;
      result.artifacts = outcome.artifacts;

      if (outcome.usedSelector) {
        result.usedSelector = outcome.usedSelector;
      }

      if (outcome.heal) {
        result.healed = outcome.heal;
      }

      finish();
      return false;
    } catch (caught) {
      lastError = caught;

      if (attempt < attempts) {
        shared.log({
          at: nowIso(),
          level: 'warn',
          source: 'engine',
          message: `${summarizeStep(step)} failed on attempt ${attempt}/${attempts}: ${messageOf(caught)}`,
        });

        await delayFor(retry, attempt);
      }
    }
  }

  result.error = toStepError(lastError);
  result.status = step.onFailure === 'soft' ? 'soft-failed' : 'failed';

  const shot = await captureFailureScreenshot(shared, step, index);

  if (shot) {
    result.artifacts = [...result.artifacts, shot];
  }

  finish();

  if (step.onFailure === 'ignore') {
    shared.log({
      at: nowIso(),
      level: 'info',
      source: 'engine',
      message: `${summarizeStep(step)} failed but is marked as optional — continuing.`,
    });
    result.status = 'skipped';
    return true;
  }

  if (step.onFailure === 'soft') {
    shared.softFailures.push({
      stepId: step.id,
      label: summarizeStep(step),
      message: result.error?.message ?? 'Assertion failed.',
    });
    return true;
  }

  throw new AbortTest(`${summarizeStep(step)} — ${result.error?.message ?? 'failed'}`);
}

/** A screenshot of the page at the exact moment a step failed. */
async function captureFailureScreenshot(
  shared: RunListContext,
  step: Step,
  index: number,
): Promise<Artifact | undefined> {
  const file = `step-${String(index + 1).padStart(3, '0')}-failure.png`;

  try {
    const buffer = await shared.page.screenshot({ fullPage: true, timeout: 5000 });
    await fs.writeFile(path.join(shared.context.artifactDir, file), buffer);

    return {
      kind: 'screenshot',
      path: path.posix.join(shared.context.artifactPrefix, file),
      label: `Failure: ${summarizeStep(step)}`,
      contentType: 'image/png',
      bytes: buffer.byteLength,
    };
  } catch {
    // The page may already be closed or crashed; the other artifacts still apply.
    return undefined;
  }
}

async function conditionHolds(step: Step, shared: RunListContext): Promise<boolean> {
  const repeat = step.repeat;

  if (!repeat?.conditionTarget) {
    return false;
  }

  const locator = locatorFor(shared.page, repeat.conditionTarget);
  const visible = await locator.isVisible().catch(() => false);

  return repeat.condition === 'hidden' ? !visible : visible;
}

function resolveIterationLimit(step: Step, scope: VariableScope, rowCount: number | undefined): number {
  const repeat = step.repeat;

  if (!repeat) {
    return 1;
  }

  switch (repeat.mode) {
    case 'fixed':
      return Math.max(0, repeat.count ?? 0);
    case 'data':
      return rowCount ?? 0;
    case 'while':
      return repeat.max;
    case 'variable': {
      const raw = repeat.countVariable ? scope.get(repeat.countVariable) : undefined;
      const parsed = Number(raw ?? 0);

      if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
      }

      return Math.min(Math.floor(parsed), repeat.max);
    }
  }
}

function dataRowsFor(test: TestCase, name: string | undefined): Array<Record<string, JsonValue>> {
  return test.dataSets.find((set) => set.name === name)?.rows ?? [];
}

/**
 * Seeds a test's variables: environment values first, then secrets resolved from
 * the process environment, then the test's own declared defaults.
 */
function buildTestScope(
  test: TestCase,
  environment: Environment | undefined,
  runScope: VariableScope,
  dataRow: DataRow | undefined,
): VariableScope {
  const scope = runScope.child();

  for (const [name, value] of Object.entries(environment?.variables ?? {})) {
    scope.set(name, value);
  }

  for (const [name, envVar] of Object.entries(environment?.secretRefs ?? {})) {
    const value = process.env[envVar];

    if (value !== undefined) {
      scope.set(name, value);
    }
  }

  for (const variable of test.variables) {
    if (variable.source === 'runtime') {
      continue;
    }

    if (!runScope.has(variable.name) && variable.defaultValue.length > 0) {
      scope.set(variable.name, interpolate(variable.defaultValue, scope, { onMissing: 'empty' }));
    }
  }

  if (dataRow) {
    scope.set('row', dataRow.values);

    for (const [key, value] of Object.entries(dataRow.values)) {
      scope.set(key, value);
    }
  }

  return scope;
}

/** Collects console messages and API responses for the failure report. */
function attachPageListeners(
  page: Page,
  log: (entry: LogEntry) => void,
  responses: CapturedResponse[],
): void {
  page.on('console', (message) => {
    const type = message.type();

    log({
      at: nowIso(),
      level: type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'info',
      source: 'console',
      message: message.text(),
    });
  });

  page.on('pageerror', (error) => {
    log({ at: nowIso(), level: 'error', source: 'page', message: error.message });
  });

  page.on('requestfailed', (request) => {
    log({
      at: nowIso(),
      level: 'warn',
      source: 'network',
      message: `${request.method()} ${request.url()} failed: ${request.failure()?.errorText ?? 'unknown error'}`,
    });
  });

  page.on('response', (response) => {
    void (async () => {
      const contentType = response.headers()['content-type'] ?? '';

      // Only JSON and text bodies are worth keeping — they are what extraction reads.
      if (!/json|text|xml/i.test(contentType)) {
        return;
      }

      const body = await response.text().catch(() => '');

      responses.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        body: body.slice(0, 200_000),
        at: nowIso(),
      });

      if (response.status() >= 400) {
        log({
          at: nowIso(),
          level: 'warn',
          source: 'network',
          message: `${response.request().method()} ${response.url()} → ${response.status()}`,
        });
      }
    })();
  });
}

/**
 * Step labels are resolved against the live scope so the report reads
 * `Fill Customer with "Ann-0"` rather than `{{row.who}}-{{_index}}`. Unresolved
 * names are left in place instead of failing — this is only a label.
 */
function labelFor(step: Step, scope: VariableScope): string {
  return interpolate(summarizeStep(step), scope, { onMissing: 'keep' });
}

function baseResult(
  step: Step,
  index: number,
  depth: number,
  status: StepResult['status'],
  label: string,
): StepResult {
  return {
    stepId: step.id,
    index,
    kind: step.kind,
    label,
    status,
    depth,
    durationMs: 0,
    attempts: 1,
    artifacts: [],
    extracted: {},
    logs: [],
  };
}

async function delayFor(retry: { delayMs: number; backoff: string } | undefined, attempt: number): Promise<void> {
  if (!retry || retry.delayMs <= 0) {
    return;
  }

  const multiplier =
    retry.backoff === 'exponential' ? 2 ** (attempt - 1) : retry.backoff === 'linear' ? attempt : 1;

  await new Promise((resolve) => setTimeout(resolve, retry.delayMs * multiplier));
}

function toStepError(caught: unknown): StepError {
  if (caught instanceof AssertionFailure) {
    return {
      message: caught.message,
      name: caught.name,
      expected: caught.expected,
      actual: caught.actual,
    };
  }

  if (caught instanceof TargetResolutionError) {
    const detail = caught.attempts.map((attempt) => `  • ${attempt.selector} — ${attempt.reason}`).join('\n');

    return {
      message: `${caught.message}\nSelectors tried:\n${detail}`,
      name: caught.name,
    };
  }

  if (caught instanceof Error) {
    return {
      message: caught.message,
      name: caught.name,
      ...(caught.stack === undefined ? {} : { stack: caught.stack }),
    };
  }

  return { message: String(caught) };
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
