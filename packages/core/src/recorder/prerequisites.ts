import type { BrowserContext, Page } from 'playwright';
import type { JsonValue } from '../model/common.js';
import type { Environment } from '../model/test.js';
import { planRun } from '../graph/plan.js';
import { executeTest } from '../engine/test-executor.js';
import { ensureDir, removeDir } from '../storage/fs-utils.js';
import type { ProjectStore } from '../storage/store.js';
import { VariableScope } from '../variables/scope.js';

/**
 * Artifacts from a setup chain go here rather than into the run history — this
 * is not a run, it is the preparation for a recording. A single reused
 * directory keeps failed attempts inspectable without accumulating on disk.
 */
export const RECORDING_SETUP_DIR = 'recording-setup';

export interface PrerequisiteResult {
  testId: string;
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  /** Steps that ran, so a failure can be reported as "step 4 of 9". */
  stepCount: number;
  error?: string;
  failedStep?: string;
}

export type PrerequisiteProgress =
  | { type: 'prerequisite:plan'; order: Array<{ testId: string; name: string }> }
  | { type: 'prerequisite:test'; testId: string; name: string; index: number; total: number }
  | { type: 'prerequisite:step'; testId: string; label: string }
  | { type: 'prerequisite:result'; result: PrerequisiteResult };

export interface RunPrerequisitesOptions {
  store: ProjectStore;
  /** Tests to run first. Their own dependencies are pulled in automatically. */
  testIds: string[];
  page: Page;
  browserContext: BrowserContext;
  environment: Environment | undefined;
  /** Inputs for the chain, e.g. a username the login test expects. */
  variables?: Record<string, JsonValue>;
  /** Ripple where the chain acts, so the tester can see it working. */
  highlight?: boolean;
  onProgress?: (event: PrerequisiteProgress) => void;
  signal?: AbortSignal;
}

export interface PrerequisiteOutcome {
  results: PrerequisiteResult[];
  /** Values the chain captured, e.g. an `orderId`, visible while recording. */
  variables: Record<string, JsonValue>;
  /** Execution order after dependency expansion. */
  order: string[];
}

/**
 * Raised when a setup test fails.
 *
 * Recording from a half-prepared state produces a test that can never pass, so
 * this stops the recorder rather than opening a browser on the wrong screen.
 */
export class PrerequisiteFailedError extends Error {
  constructor(
    readonly result: PrerequisiteResult,
    readonly completed: PrerequisiteResult[],
  ) {
    super(
      `"${result.name}" failed, so recording did not start: ${result.failedStep ?? result.error ?? 'unknown error'}`,
    );
    this.name = 'PrerequisiteFailedError';
  }
}

/**
 * Runs a chain of existing tests in the browser the recorder is about to use,
 * so recording can begin from wherever they finish — logged in, with records
 * already created, on the right screen.
 *
 * Unlike a real run, every test here shares one browser context. That is the
 * point: state accumulates instead of being handed over as a storage snapshot,
 * so anything a test leaves on screen is still there when recording starts.
 * The consequence is that a prerequisite's own `auth.session` is not applied —
 * the context already exists by then. Use the recorder's `session` option to
 * start the whole chain from a saved login.
 */
export async function runPrerequisites(options: RunPrerequisitesOptions): Promise<PrerequisiteOutcome> {
  const { store, page, browserContext, environment, onProgress, signal } = options;

  const [allTests, allSnippets] = await Promise.all([store.listTests(), store.listSnippets()]);

  const plan = planRun({ tests: allTests, requestedIds: options.testIds });

  if (plan.missing.length > 0) {
    throw new Error(`Cannot record after a test that no longer exists: ${plan.missing.join(', ')}`);
  }

  if (plan.order.length === 0) {
    return { results: [], variables: options.variables ?? {}, order: [] };
  }

  const byId = new Map(allTests.map((test) => [test.id, test]));
  const snippets = new Map(allSnippets.map((snippet) => [snippet.id, snippet]));

  const runDir = store.runDir(RECORDING_SETUP_DIR);
  await removeDir(runDir).catch(() => undefined);
  await ensureDir(runDir);

  const scope = VariableScope.fromObject(options.variables ?? {});
  const results: PrerequisiteResult[] = [];

  onProgress?.({
    type: 'prerequisite:plan',
    order: plan.order.map((id) => ({ testId: id, name: byId.get(id)?.name ?? id })),
  });

  for (const [index, testId] of plan.order.entries()) {
    const test = byId.get(testId);

    if (!test) {
      continue;
    }

    onProgress?.({
      type: 'prerequisite:test',
      testId,
      name: test.name,
      index,
      total: plan.order.length,
    });

    const outcome = await executeTest({
      test,
      snippets,
      page,
      browserContext,
      store,
      environment,
      runScope: scope,
      runId: RECORDING_SETUP_DIR,
      runDir,
      highlight: options.highlight ?? false,
      emit: (event) => {
        if (event.type === 'step:start') {
          onProgress?.({ type: 'prerequisite:step', testId, label: event.step.label });
        }
      },
      ...(signal === undefined ? {} : { signal }),
    });

    const failedStep = outcome.steps.find((step) => step.status === 'failed');

    const result: PrerequisiteResult = {
      testId,
      name: test.name,
      status: outcome.status === 'passed' ? 'passed' : 'failed',
      durationMs: outcome.durationMs,
      stepCount: outcome.steps.length,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(failedStep === undefined
        ? {}
        : { failedStep: `${failedStep.label}${failedStep.error ? ` — ${failedStep.error.message}` : ''}` }),
    };

    results.push(result);
    onProgress?.({ type: 'prerequisite:result', result });

    if (result.status !== 'passed') {
      throw new PrerequisiteFailedError(result, results);
    }
  }

  return { results, variables: scope.toObject(), order: plan.order };
}
