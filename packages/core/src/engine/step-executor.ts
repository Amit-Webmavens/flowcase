import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { JsonValue } from '../model/common.js';
import type { Artifact, HealEvent, LogEntry, StepError } from '../model/run.js';
import { nowIso } from '../model/common.js';
import type { Step } from '../model/step.js';
import type { Environment, TestCase } from '../model/test.js';
import { locatorFor, resolveTarget } from '../selectors/resolve.js';
import type { ProjectStore } from '../storage/store.js';
import { describeMatcher, matchText, matchUrl } from '../util/match.js';
import type { CapturedResponse } from '../variables/extract.js';
import { applyExtractions } from '../variables/extract.js';
import { interpolate, resolveTyped } from '../variables/interpolate.js';
import type { VariableScope } from '../variables/scope.js';
import { showRipple } from './highlight.js';
import type { MockRegistry } from './mocks.js';
import { compareScreenshot } from './visual.js';

export interface StepContext {
  page: Page;
  scope: VariableScope;
  responses: CapturedResponse[];
  mocks: MockRegistry;
  store: ProjectStore;
  test: TestCase;
  environment: Environment | undefined;
  /** Absolute directory for this test's artifacts inside the run folder. */
  artifactDir: string;
  /** `artifactDir` relative to the run root — what gets stored in results. */
  artifactPrefix: string;
  defaultTimeoutMs: number;
  /** Ripple where the runner acts. Only worth doing when someone is watching. */
  highlight: boolean;
  log: (entry: LogEntry) => void;
}

export interface StepOutcome {
  status: 'passed' | 'failed';
  error?: StepError;
  usedSelector?: string;
  heal?: HealEvent;
  extracted: Record<string, JsonValue>;
  artifacts: Artifact[];
}

export class AssertionFailure extends Error {
  constructor(
    message: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(message);
    this.name = 'AssertionFailure';
  }
}

/**
 * Runs one step against the live page.
 *
 * Repeats, groups and retries are handled a level up in the test executor; this
 * function performs exactly one attempt at one action and reports what happened.
 */
export async function executeStep(step: Step, context: StepContext): Promise<StepOutcome> {
  const { page, scope } = context;
  const timeoutMs = step.timeoutMs ?? context.defaultTimeoutMs;
  const artifacts: Artifact[] = [];

  let usedSelector: string | undefined;
  let heal: HealEvent | undefined;

  /** Resolves the step's element, recording which selector actually worked. */
  const target = async (state: 'visible' | 'attached' = 'visible') => {
    if (!step.target) {
      throw new Error(`Step "${step.label || step.kind}" has no element selected.`);
    }

    const resolved = await resolveTarget(page, step.target, { timeoutMs, state });
    usedSelector = resolved.selector;

    if (resolved.heal) {
      heal = resolved.heal;
      context.log({
        at: nowIso(),
        level: 'warn',
        source: 'engine',
        message: `Selector healed: ${resolved.heal.from} → ${resolved.heal.to} (confidence ${resolved.heal.confidence.toFixed(2)})`,
      });
    }

    return resolved.locator;
  };

  /**
   * Same as `target`, but marks the element first. Used only by steps that act
   * on the page — a ripple on every assertion would be noise, not a signal.
   */
  const acting = async (state: 'visible' | 'attached' = 'visible') => {
    const locator = await target(state);

    if (context.highlight) {
      await showRipple(page, locator);
    }

    return locator;
  };

  const text = (raw: string | undefined): string => interpolate(raw ?? '', scope);

  switch (step.kind) {
    // ── Navigation ─────────────────────────────────────────────────────────
    case 'goto': {
      await page.goto(absoluteUrl(text(step.value), context.environment), {
        timeout: timeoutMs,
        waitUntil: 'domcontentloaded',
      });
      break;
    }

    case 'reload':
      await page.reload({ timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      break;

    case 'goBack':
      await page.goBack({ timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      break;

    case 'goForward':
      await page.goForward({ timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      break;

    case 'setViewport':
      await page.setViewportSize({
        width: Number(text(step.value)) || 1280,
        height: Number(text(step.value2)) || 720,
      });
      break;

    // ── Interaction ────────────────────────────────────────────────────────
    case 'click':
      await (await acting()).click({ timeout: timeoutMs });
      break;

    case 'dblclick':
      await (await acting()).dblclick({ timeout: timeoutMs });
      break;

    case 'rightClick':
      await (await acting()).click({ button: 'right', timeout: timeoutMs });
      break;

    case 'fill':
      await (await acting()).fill(text(step.value), { timeout: timeoutMs });
      break;

    case 'type': {
      const locator = await acting();
      const delay = Number(text(step.value2));
      await locator.pressSequentially(text(step.value), {
        timeout: timeoutMs,
        ...(Number.isFinite(delay) && delay > 0 ? { delay } : {}),
      });
      break;
    }

    case 'press': {
      const key = text(step.value);

      if (step.target) {
        await (await target()).press(key, { timeout: timeoutMs });
      } else {
        await page.keyboard.press(key);
      }
      break;
    }

    case 'select': {
      const locator = await acting();
      const option = text(step.value);

      try {
        await locator.selectOption(option, { timeout: timeoutMs });
      } catch {
        // Fall back to matching the visible label, which is what a tester sees.
        await locator.selectOption({ label: option }, { timeout: timeoutMs });
      }
      break;
    }

    case 'check':
      await (await acting()).check({ timeout: timeoutMs });
      break;

    case 'uncheck':
      await (await acting()).uncheck({ timeout: timeoutMs });
      break;

    case 'hover':
      await (await acting()).hover({ timeout: timeoutMs });
      break;

    case 'focus':
      await (await target()).focus({ timeout: timeoutMs });
      break;

    case 'clear':
      await (await acting()).clear({ timeout: timeoutMs });
      break;

    case 'upload': {
      const locator = await target('attached');
      const files = step.files.map((file) =>
        path.isAbsolute(file) ? file : path.join(context.store.fixturesDir, interpolate(file, scope)),
      );
      await locator.setInputFiles(files, { timeout: timeoutMs });
      break;
    }

    case 'dragAndDrop': {
      const source = await target();
      await source.dragTo(page.locator(text(step.value)), { timeout: timeoutMs });
      break;
    }

    case 'scrollTo':
      await (await target('attached')).scrollIntoViewIfNeeded({ timeout: timeoutMs });
      break;

    // ── Waiting ────────────────────────────────────────────────────────────
    case 'waitForSelector':
      await target();
      break;

    case 'waitForHidden': {
      if (!step.target) {
        throw new Error('Choose the element that should disappear.');
      }

      await locatorFor(page, step.target).waitFor({ state: 'hidden', timeout: timeoutMs });
      break;
    }

    case 'waitForUrl': {
      const pattern = text(step.value);
      await page.waitForURL((url) => matchUrl(pattern, url.toString()), { timeout: timeoutMs });
      break;
    }

    case 'waitForText':
      await page.getByText(text(step.value)).first().waitFor({ state: 'visible', timeout: timeoutMs });
      break;

    case 'waitForTimeout':
      await page.waitForTimeout(Math.max(0, Number(text(step.value)) || 0));
      break;

    case 'waitForResponse': {
      const pattern = text(step.value);
      const response = await page.waitForResponse((candidate) => matchUrl(pattern, candidate.url()), {
        timeout: timeoutMs,
      });

      context.responses.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        body: await safeBody(response),
        at: nowIso(),
      });
      break;
    }

    case 'waitForLoadState': {
      const state = text(step.value) as 'load' | 'domcontentloaded' | 'networkidle';
      await page.waitForLoadState(state, { timeout: timeoutMs });
      break;
    }

    // ── Assertions ─────────────────────────────────────────────────────────
    case 'assertVisible':
      await target('visible');
      break;

    case 'assertHidden': {
      if (!step.target) {
        throw new Error('Choose the element that should be hidden.');
      }

      await locatorFor(page, step.target).waitFor({ state: 'hidden', timeout: timeoutMs });
      break;
    }

    case 'assertText': {
      const locator = await target('attached');
      const actual = (await locator.innerText({ timeout: timeoutMs })).trim();
      assertMatches(step, actual, text(step.value), 'text');
      break;
    }

    case 'assertValue': {
      const locator = await target('attached');
      const actual = await locator.inputValue({ timeout: timeoutMs });
      assertMatches(step, actual, text(step.value), 'value');
      break;
    }

    case 'assertUrl':
      assertMatches(step, page.url(), text(step.value), 'URL');
      break;

    case 'assertTitle':
      assertMatches(step, await page.title(), text(step.value), 'page title');
      break;

    case 'assertCount': {
      if (!step.target) {
        throw new Error('Choose the elements to count.');
      }

      const expected = Number(text(step.value));
      const actual = await locatorFor(page, step.target).count();

      if (actual !== expected) {
        throw new AssertionFailure(
          `Expected ${expected} matching elements but found ${actual}.`,
          String(expected),
          String(actual),
        );
      }
      break;
    }

    case 'assertAttribute': {
      const locator = await target('attached');
      const attribute = text(step.value);
      const actual = (await locator.getAttribute(attribute, { timeout: timeoutMs })) ?? '';
      assertMatches(step, actual, text(step.value2), `attribute "${attribute}"`);
      break;
    }

    case 'assertChecked': {
      const locator = await target('attached');

      if (!(await locator.isChecked({ timeout: timeoutMs }))) {
        throw new AssertionFailure('Expected the control to be checked.', 'checked', 'not checked');
      }
      break;
    }

    case 'assertEnabled': {
      const locator = await target('attached');

      if (!(await locator.isEnabled({ timeout: timeoutMs }))) {
        throw new AssertionFailure('Expected the control to be enabled.', 'enabled', 'disabled');
      }
      break;
    }

    case 'assertDisabled': {
      const locator = await target('attached');

      if (!(await locator.isDisabled({ timeout: timeoutMs }))) {
        throw new AssertionFailure('Expected the control to be disabled.', 'disabled', 'enabled');
      }
      break;
    }

    // ── Data ───────────────────────────────────────────────────────────────
    case 'extract': {
      const outcome = await applyExtractions(step.extract, {
        page,
        scope,
        responses: context.responses,
        timeoutMs,
      });

      if (outcome.errors.length > 0) {
        throw new Error(outcome.errors.join(' '));
      }

      return { status: 'passed', extracted: outcome.values, artifacts, ...(usedSelector ? { usedSelector } : {}), ...(heal ? { heal } : {}) };
    }

    case 'setVariable': {
      const name = text(step.value);
      const value = resolveTyped(step.value2 ?? '', scope);
      scope.set(name, value);

      return { status: 'passed', extracted: { [name]: value }, artifacts };
    }

    // ── Utility ────────────────────────────────────────────────────────────
    case 'screenshot': {
      const label = text(step.value) || step.id;
      const file = `${sanitize(label)}.png`;
      const buffer = await page.screenshot({ fullPage: true });
      await fs.writeFile(path.join(context.artifactDir, file), buffer);

      artifacts.push({
        kind: 'screenshot',
        path: path.posix.join(context.artifactPrefix, file),
        label,
        contentType: 'image/png',
        bytes: buffer.byteLength,
      });
      break;
    }

    case 'visualCheck': {
      const visual = step.visual ?? {
        threshold: 0.01,
        pixelThreshold: 0.1,
        mask: [],
        fullPage: false,
        updateBaseline: false,
      };
      const name = sanitize(text(step.value) || visual.name || step.id);

      const buffer = await page.screenshot({
        fullPage: visual.fullPage,
        mask: visual.mask.map((maskTarget) => locatorFor(page, maskTarget)),
      });

      const result = await compareScreenshot({
        screenshot: buffer,
        baselinePath: context.store.baselinePath(context.test.id, name),
        outputDir: context.artifactDir,
        name,
        threshold: visual.threshold,
        pixelThreshold: visual.pixelThreshold,
        updateBaseline: visual.updateBaseline,
      });

      if (result.actualPath) {
        artifacts.push({
          kind: 'actual',
          path: path.posix.join(context.artifactPrefix, path.basename(result.actualPath)),
          label: `${name} (this run)`,
          contentType: 'image/png',
        });
      }

      if (result.diffPath) {
        artifacts.push({
          kind: 'diff',
          path: path.posix.join(context.artifactPrefix, path.basename(result.diffPath)),
          label: `${name} (diff)`,
          contentType: 'image/png',
        });
      }

      if (result.status === 'failed') {
        throw new AssertionFailure(
          result.message ?? 'The screenshot does not match its baseline.',
          'matches baseline',
          `${(result.diffRatio * 100).toFixed(2)}% of pixels differ`,
        );
      }

      if (result.status === 'baseline-created') {
        context.log({ at: nowIso(), level: 'info', source: 'engine', message: result.message ?? '' });
      }
      break;
    }

    case 'mockRoute': {
      if (!step.mock) {
        throw new Error('This step has no route configured.');
      }

      await context.mocks.apply(step.mock, scope);
      break;
    }

    case 'unmockRoute':
      await context.mocks.remove(text(step.value));
      break;

    case 'saveSession': {
      const name = text(step.value);
      await page.context().storageState({ path: context.store.sessionPath(name) });
      context.log({ at: nowIso(), level: 'info', source: 'engine', message: `Saved session "${name}".` });
      break;
    }

    case 'loadSession':
      await loadSession(page, context.store.sessionPath(text(step.value)));
      break;

    case 'comment':
    case 'group':
    case 'snippet':
      // Structural steps do no work themselves.
      break;
  }

  return {
    status: 'passed',
    extracted: {},
    artifacts,
    ...(usedSelector ? { usedSelector } : {}),
    ...(heal ? { heal } : {}),
  };
}

function assertMatches(step: Pick<Step, 'matcher'>, actual: string, expected: string, subject: string): void {
  if (matchText(step.matcher, actual, expected)) {
    return;
  }

  throw new AssertionFailure(
    `Expected ${subject} to ${describeMatcher(step.matcher)} "${expected}", but it was "${truncate(actual)}".`,
    expected,
    actual,
  );
}

/** Resolves a relative path against the environment's base URL. */
export function absoluteUrl(value: string, environment: Environment | undefined): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value;
  }

  const base = environment?.baseUrl ?? '';

  if (base.length === 0) {
    return value;
  }

  return `${base.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
}

/**
 * Playwright cannot attach a storage state to a live context, so a session is
 * restored by replaying its cookies and origin storage, then reloading.
 */
async function loadSession(page: Page, sessionFile: string): Promise<void> {
  const raw = await fs.readFile(sessionFile, 'utf8').catch(() => undefined);

  if (raw === undefined) {
    throw new Error(`No saved session at ${sessionFile}. Run the test that saves it first.`);
  }

  const state = JSON.parse(raw) as {
    cookies?: Parameters<ReturnType<Page['context']>['addCookies']>[0];
    origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };

  if (state.cookies?.length) {
    await page.context().addCookies(state.cookies);
  }

  for (const origin of state.origins ?? []) {
    await page.goto(origin.origin, { waitUntil: 'domcontentloaded' });
    await page.evaluate((entries) => {
      for (const entry of entries) {
        window.localStorage.setItem(entry.name, entry.value);
      }
    }, origin.localStorage);
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function safeBody(response: { text: () => Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'artifact';
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
