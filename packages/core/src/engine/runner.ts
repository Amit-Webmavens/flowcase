import path from 'node:path';
import fs from 'node:fs/promises';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import type { JsonValue } from '../model/common.js';
import { newId, nowIso } from '../model/common.js';
import { summarizeStep } from '../model/catalog.js';
import type { Run, RunTrigger, StepResult, TestResult } from '../model/run.js';
import type { Step } from '../model/step.js';
import type { Environment, Snippet, TestCase } from '../model/test.js';
import { planRun } from '../graph/plan.js';
import type { RunPlan } from '../graph/plan.js';
import { ensureDir, pathExists } from '../storage/fs-utils.js';
import type { ProjectStore } from '../storage/store.js';
import { hasErrors, validateTest } from '../model/validate.js';
import { interpolate } from '../variables/interpolate.js';
import { VariableScope } from '../variables/scope.js';
import { EventBus } from './events.js';
import type { RunEventHandler } from './events.js';
import { inlineSnippets } from './inline.js';
import type { DataRow } from './test-executor.js';
import { executeTest } from './test-executor.js';

export interface StartRunOptions {
  store: ProjectStore;
  /** Tests the user asked for. Empty runs everything that passes the tag filter. */
  testIds?: string[];
  tags?: string[];
  environmentId?: string;
  /** Inputs supplied at run time; they win over declared defaults. */
  variables?: Record<string, JsonValue>;
  dryRun?: boolean;
  /** Show the browser window. Overrides the environment setting. */
  headed?: boolean;
  /** How many independent tests may run at once. Dependencies always serialise. */
  concurrency?: number;
  triggeredBy?: RunTrigger;
  triggeredByUser?: string;
  approvedOnly?: boolean;
  onEvent?: RunEventHandler;
  signal?: AbortSignal;
}

/**
 * Plans and executes a run.
 *
 * Tests execute in dependency order; independent ones may run in parallel up to
 * `concurrency`. Values captured by one test stay visible to the tests that
 * depend on it, and the browser session is handed down the chain so a login test
 * only has to run once.
 */
export async function startRun(options: StartRunOptions): Promise<Run> {
  const { store, signal } = options;
  const bus = new EventBus();

  if (options.onEvent) {
    bus.subscribe(options.onEvent);
  }

  const [allTests, allSnippets, environment] = await Promise.all([
    store.listTests(),
    store.listSnippets(),
    resolveEnvironment(store, options.environmentId),
  ]);

  const plan = planRun({
    tests: allTests,
    ...(options.testIds === undefined ? {} : { requestedIds: options.testIds }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.approvedOnly === undefined ? {} : { approvedOnly: options.approvedOnly }),
  });

  const byId = new Map(allTests.map((test) => [test.id, test]));
  const snippets = new Map(allSnippets.map((snippet) => [snippet.id, snippet]));

  const runId = newId('run');
  const runDir = store.runDir(runId);
  await ensureDir(runDir);

  const run: Run = {
    id: runId,
    requestedTestIds: plan.requested,
    plan: plan.order,
    status: 'running',
    ...(environment === undefined ? {} : { environmentId: environment.id, environmentName: environment.name }),
    dryRun: options.dryRun ?? false,
    concurrency: Math.max(1, options.concurrency ?? 1),
    triggeredBy: options.triggeredBy ?? 'ui',
    ...(options.triggeredByUser === undefined ? {} : { triggeredByUser: options.triggeredByUser }),
    tagFilter: options.tags ?? [],
    startedAt: nowIso(),
    durationMs: 0,
    results: [],
    variables: {},
  };

  await store.beginRun(run);
  bus.emit({ type: 'run:start', runId, run });

  const startedMs = Date.now();
  const runScope = VariableScope.fromObject(options.variables ?? {});

  try {
    if (plan.order.length === 0) {
      run.error = describeEmptyPlan(plan);
    } else if (run.dryRun) {
      run.results = await dryRunResults(plan, byId, snippets, environment, runScope);
    } else {
      await executePlan({ run, plan, byId, snippets, environment, runScope, store, bus, options });
    }
  } catch (error) {
    run.status = 'aborted';
    run.error = error instanceof Error ? error.message : String(error);
  }

  run.finishedAt = nowIso();
  run.durationMs = Date.now() - startedMs;
  run.variables = runScope.toObject();

  if (run.status === 'running') {
    const failed = run.results.some((result) => result.status === 'failed');
    // A dry run proves nothing about the app, so it never reports as passed.
    run.status = signal?.aborted ? 'aborted' : run.dryRun ? 'skipped' : failed ? 'failed' : 'passed';
  }

  const tags = [...new Set(run.results.flatMap((result) => byId.get(result.testId)?.tags ?? []))];
  await store.completeRun(run, tags);
  bus.emit({ type: 'run:end', runId, run });

  return run;
}

interface ExecutePlanArgs {
  run: Run;
  plan: RunPlan;
  byId: Map<string, TestCase>;
  snippets: Map<string, Snippet>;
  environment: Environment | undefined;
  runScope: VariableScope;
  store: ProjectStore;
  bus: EventBus;
  options: StartRunOptions;
}

async function executePlan(args: ExecutePlanArgs): Promise<void> {
  const { run, plan, byId, snippets, environment, runScope, store, bus, options } = args;

  const browser = await launchBrowser(environment, options.headed);

  /** Storage state handed from one test to the next, so logins are not repeated. */
  let inheritedState: BrowserContextOptions['storageState'];

  const remaining = [...plan.order];
  const succeeded = new Set<string>();
  const finished = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const concurrency = Math.max(1, options.concurrency ?? 1);

  const runOne = async (testId: string, index: number): Promise<void> => {
    const test = byId.get(testId);

    if (!test) {
      return;
    }

    const issues = validateTest(test, { snippetIds: new Set(snippets.keys()) });

    if (hasErrors(issues)) {
      run.results.push(
        skipped(test, `The test has unresolved problems: ${issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' ')}`),
      );
      finished.add(testId);
      return;
    }

    bus.emit({
      type: 'test:start',
      runId: run.id,
      testId,
      testName: test.name,
      index,
      total: plan.order.length,
    });

    const rows = dataRowsFor(test);
    let allPassed = true;

    for (const row of rows) {
      options.signal?.throwIfAborted();

      const runDir = store.runDir(run.id);
      const videoDir = path.join(runDir, '_video', test.id);
      const { context, page } = await createContext(browser, store, environment, test, inheritedState, videoDir);
      const artifactPrefix = `${test.id}${row ? `-row${row.index + 1}` : ''}`;

      let result: TestResult;

      try {
        result = await executeTest({
          test,
          snippets,
          page,
          browserContext: context,
          store,
          environment,
          runScope,
          runId: run.id,
          runDir: store.runDir(run.id),
          ...(row === undefined ? {} : { dataRow: row }),
          emit: (event) => bus.emit(event),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        result = {
          ...skipped(test, error instanceof Error ? error.message : String(error)),
          status: 'failed',
        };
      }

      // Capture the session before closing so the next test can reuse the login.
      if (result.status === 'passed') {
        inheritedState = await context.storageState().catch(() => undefined);
      }

      const video = page.video();
      await context.close().catch(() => undefined);

      if (video) {
        if (result.status === 'failed') {
          const target = path.join(runDir, artifactPrefix, 'video.webm');
          await video.saveAs(target).catch(() => undefined);

          if (await pathExists(target)) {
            result.artifacts.push({
              kind: 'video',
              path: path.posix.join(artifactPrefix, 'video.webm'),
              label: 'Recording',
              contentType: 'video/webm',
            });
          }
        }

        await video.delete().catch(() => undefined);
      }

      await fs.rm(videoDir, { recursive: true, force: true }).catch(() => undefined);

      run.results.push(result);
      bus.emit({ type: 'test:end', runId: run.id, testId, result });
      await store.updateRun(run);

      if (result.status !== 'passed') {
        allPassed = false;
      }
    }

    finished.add(testId);

    if (allPassed) {
      succeeded.add(testId);
    }
  };

  try {
    let index = 0;

    while (remaining.length > 0 || running.size > 0) {
      options.signal?.throwIfAborted();

      // Start everything whose dependencies have already passed.
      for (let position = 0; position < remaining.length && running.size < concurrency; ) {
        const testId = remaining[position];

        if (testId === undefined) {
          position += 1;
          continue;
        }

        const test = byId.get(testId);
        const dependencies = test?.dependsOn ?? [];

        const blocked = dependencies.some((dependency) => plan.order.includes(dependency) && !finished.has(dependency));
        const brokenDependency = dependencies.find(
          (dependency) => finished.has(dependency) && !succeeded.has(dependency),
        );

        if (brokenDependency) {
          remaining.splice(position, 1);
          const dependencyName = byId.get(brokenDependency)?.name ?? brokenDependency;

          if (test) {
            run.results.push(skipped(test, `Skipped because "${dependencyName}" did not pass.`));
            bus.emit({ type: 'test:end', runId: run.id, testId, result: run.results[run.results.length - 1]! });
          }

          finished.add(testId);
          continue;
        }

        if (blocked) {
          position += 1;
          continue;
        }

        remaining.splice(position, 1);
        const promise = runOne(testId, index).finally(() => running.delete(testId));
        index += 1;
        running.set(testId, promise);
      }

      if (running.size === 0 && remaining.length > 0) {
        // Everything left is blocked by a test that will never run.
        for (const testId of remaining.splice(0)) {
          const test = byId.get(testId);

          if (test) {
            run.results.push(skipped(test, 'Skipped because one of its dependencies never ran.'));
          }
        }

        break;
      }

      if (running.size > 0) {
        await Promise.race(running.values());
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function createContext(
  browser: Browser,
  store: ProjectStore,
  environment: Environment | undefined,
  test: TestCase,
  inherited: BrowserContextOptions['storageState'],
  videoDir: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const namedSession = test.auth.session ? store.sessionPath(test.auth.session) : undefined;
  const useNamed = namedSession !== undefined && (await pathExists(namedSession));

  const storageState = useNamed
    ? namedSession
    : test.auth.inheritFromDependency
      ? inherited
      : undefined;

  const context = await browser.newContext({
    viewport: environment?.viewport ?? { width: 1280, height: 720 },
    ignoreHTTPSErrors: environment?.ignoreHttpsErrors ?? false,
    recordVideo: { dir: videoDir },
    ...(environment?.locale === undefined ? {} : { locale: environment.locale }),
    ...(environment?.timezoneId === undefined ? {} : { timezoneId: environment.timezoneId }),
    ...(environment && Object.keys(environment.extraHttpHeaders).length > 0
      ? { extraHTTPHeaders: environment.extraHttpHeaders }
      : {}),
    ...(storageState === undefined ? {} : { storageState }),
  });

  const page = await context.newPage();

  return { context, page };
}

async function launchBrowser(environment: Environment | undefined, headed: boolean | undefined): Promise<Browser> {
  const headless = headed === undefined ? (environment?.headless ?? true) : !headed;

  switch (environment?.browser ?? 'chromium') {
    case 'firefox':
      return firefox.launch({ headless });
    case 'webkit':
      return webkit.launch({ headless });
    default:
      return chromium.launch({ headless });
  }
}

async function resolveEnvironment(
  store: ProjectStore,
  environmentId: string | undefined,
): Promise<Environment | undefined> {
  if (environmentId) {
    const environment = await store.getEnvironment(environmentId);

    if (environment) {
      return environment;
    }
  }

  return store.getDefaultEnvironment();
}

/** One entry per data row, or a single undefined entry for a normal test. */
function dataRowsFor(test: TestCase): Array<DataRow | undefined> {
  if (!test.dataDrivenSet) {
    return [undefined];
  }

  const set = test.dataSets.find((candidate) => candidate.name === test.dataDrivenSet);

  if (!set || set.rows.length === 0) {
    return [undefined];
  }

  return set.rows.map((values, index) => ({
    index,
    values,
    label: describeRow(values, index),
  }));
}

function describeRow(values: Record<string, JsonValue>, index: number): string {
  const [firstKey] = Object.keys(values);
  const first = firstKey === undefined ? undefined : values[firstKey];

  return first === undefined || first === null ? `Row ${index + 1}` : `${firstKey}: ${String(first)}`;
}

/**
 * Preview mode. Resolves every variable and reports what each step would do
 * without opening a browser, so a tester can check a data-driven run before
 * committing to it.
 */
async function dryRunResults(
  plan: RunPlan,
  byId: Map<string, TestCase>,
  snippets: Map<string, Snippet>,
  environment: Environment | undefined,
  runScope: VariableScope,
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const testId of plan.order) {
    const test = byId.get(testId);

    if (!test) {
      continue;
    }

    const scope = runScope.child();

    for (const [name, value] of Object.entries(environment?.variables ?? {})) {
      scope.set(name, value);
    }

    for (const variable of test.variables) {
      if (variable.defaultValue.length > 0 && !scope.has(variable.name)) {
        scope.set(variable.name, variable.defaultValue);
      }
    }

    const steps: StepResult[] = [];
    const flatten = (list: Step[], depth: number): void => {
      for (const step of list) {
        steps.push({
          stepId: step.id,
          index: steps.length,
          kind: step.kind,
          label: interpolate(summarizeStep(step), scope, { onMissing: 'keep' }),
          status: step.enabled ? 'skipped' : 'skipped',
          depth,
          durationMs: 0,
          attempts: 0,
          artifacts: [],
          extracted: {},
          logs: [],
        });

        flatten(step.children, depth + 1);
      }
    };

    flatten(inlineSnippets(test.steps, snippets), 0);

    results.push({
      testId: test.id,
      testName: test.name,
      testVersion: test.version,
      status: 'skipped',
      durationMs: 0,
      steps,
      artifacts: [],
      variables: scope.toObject(),
      softFailures: [],
      skipReason: 'Dry run — nothing was executed.',
    });
  }

  return results;
}

function skipped(test: TestCase, reason: string): TestResult {
  return {
    testId: test.id,
    testName: test.name,
    testVersion: test.version,
    status: 'skipped',
    durationMs: 0,
    steps: [],
    artifacts: [],
    variables: {},
    softFailures: [],
    skipReason: reason,
  };
}

function describeEmptyPlan(plan: RunPlan): string {
  if (plan.unapproved.length > 0) {
    return 'Nothing ran: every matching test is still awaiting approval.';
  }

  if (plan.missing.length > 0) {
    return `Nothing ran: ${plan.missing.length} referenced test(s) no longer exist.`;
  }

  return 'Nothing matched the selection.';
}
