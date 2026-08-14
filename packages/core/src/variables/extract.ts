import type { Page } from 'playwright';
import type { JsonValue } from '../model/common.js';
import type { ExtractionRule } from '../model/step.js';
import { locatorFor, resolveTarget } from '../selectors/resolve.js';
import { matchUrl } from '../util/match.js';
import { interpolate, readPath, splitPath } from './interpolate.js';
import type { VariableScope } from './scope.js';

/** A response the engine observed, retained so `extract` steps can read it. */
export interface CapturedResponse {
  url: string;
  method: string;
  status: number;
  body: string;
  at: string;
}

export interface ExtractionContext {
  page: Page;
  scope: VariableScope;
  /** Responses seen so far in this test, oldest first. */
  responses: CapturedResponse[];
  timeoutMs: number;
}

export class ExtractionError extends Error {
  constructor(readonly ruleName: string, message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/**
 * Reads one runtime value out of the page, the URL, or an observed API response.
 *
 * This is what makes chained tests work: a step captures the id of the record it
 * just created — from the redirect URL, the page body, or the JSON the app sent
 * back — and later steps and dependent tests reference it as `{{orderId}}`.
 */
export async function runExtraction(
  rule: ExtractionRule,
  context: ExtractionContext,
): Promise<JsonValue | undefined> {
  const raw = await readRawValue(rule, context);

  if (raw === undefined || raw === null) {
    return undefined;
  }

  return applyPattern(rule, raw);
}

async function readRawValue(
  rule: ExtractionRule,
  context: ExtractionContext,
): Promise<JsonValue | undefined> {
  const { page, scope } = context;

  switch (rule.from) {
    case 'url':
      return page.url();

    case 'title':
      return page.title();

    case 'literal':
      return interpolate(rule.literal ?? '', scope);

    case 'text': {
      const resolved = await requireTarget(rule, context);
      return (await resolved.innerText()).trim();
    }

    case 'inputValue': {
      const resolved = await requireTarget(rule, context);
      return resolved.inputValue();
    }

    case 'attribute': {
      const resolved = await requireTarget(rule, context);
      return (await resolved.getAttribute(rule.attribute ?? '')) ?? undefined;
    }

    case 'count': {
      if (!rule.target) {
        throw new ExtractionError(rule.name, 'Capturing a count needs an element.');
      }

      return locatorFor(page, rule.target).count();
    }

    case 'storage': {
      const key = interpolate(rule.storageKey ?? '', scope);

      if (rule.storageType === 'cookie') {
        const cookies = await page.context().cookies();
        return cookies.find((cookie) => cookie.name === key)?.value;
      }

      const type = rule.storageType ?? 'local';

      return page.evaluate(
        ([storageType, storageKey]) =>
          (storageType === 'session' ? window.sessionStorage : window.localStorage).getItem(
            storageKey ?? '',
          ) ?? undefined,
        [type, key] as const,
      );
    }

    case 'response': {
      const pattern = interpolate(rule.urlPattern ?? '', scope);
      const match = [...context.responses].reverse().find((response) => matchUrl(pattern, response.url));

      if (!match) {
        throw new ExtractionError(
          rule.name,
          `No network response matched "${pattern}". Add a "Wait for network response" step before this one if the request happens asynchronously.`,
        );
      }

      if (!rule.jsonPath) {
        return match.body;
      }

      let parsed: JsonValue;

      try {
        parsed = JSON.parse(match.body) as JsonValue;
      } catch {
        throw new ExtractionError(
          rule.name,
          `The response from ${match.url} is not JSON, so "${rule.jsonPath}" cannot be read from it.`,
        );
      }

      return readPath(parsed, splitPath(rule.jsonPath));
    }
  }
}

async function requireTarget(rule: ExtractionRule, context: ExtractionContext) {
  if (!rule.target) {
    throw new ExtractionError(rule.name, `Capturing from ${rule.from} needs an element.`);
  }

  const resolved = await resolveTarget(context.page, rule.target, {
    timeoutMs: context.timeoutMs,
    state: 'attached',
  });

  return resolved.locator;
}

/** Applies the optional regular expression narrowing to a captured value. */
function applyPattern(rule: ExtractionRule, raw: JsonValue): JsonValue | undefined {
  if (!rule.pattern) {
    return raw;
  }

  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const match = new RegExp(rule.pattern).exec(text ?? '');

  if (!match) {
    return undefined;
  }

  return match[rule.group] ?? match[0];
}

export interface ExtractionOutcome {
  values: Record<string, JsonValue>;
  errors: string[];
}

/**
 * Runs every rule attached to a step and writes the results into the scope.
 * Required rules that produce nothing are reported so the step can fail with a
 * message naming the variable rather than a generic error.
 */
export async function applyExtractions(
  rules: ExtractionRule[],
  context: ExtractionContext,
): Promise<ExtractionOutcome> {
  const values: Record<string, JsonValue> = {};
  const errors: string[] = [];

  for (const rule of rules) {
    try {
      const value = await runExtraction(rule, context);

      if (value === undefined) {
        if (rule.required) {
          errors.push(`Could not capture "${rule.name}" from ${rule.from}.`);
        }
        continue;
      }

      values[rule.name] = value;

      if (rule.scope === 'run') {
        context.scope.setRunScoped(rule.name, value);
      } else {
        context.scope.set(rule.name, value);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (rule.required) {
        errors.push(message);
      }
    }
  }

  return { values, errors };
}
