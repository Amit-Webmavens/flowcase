import { randomUUID } from 'node:crypto';
import type { JsonValue } from '../model/common.js';
import type { VariableScope } from './scope.js';

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

export type MissingBehaviour = 'throw' | 'empty' | 'keep';

export interface InterpolateOptions {
  /** What to do when a referenced name has no value. Runs default to failing loudly. */
  onMissing?: MissingBehaviour;
  /** Extra values that win over the scope — used for per-iteration bindings. */
  overrides?: Record<string, JsonValue>;
}

export class MissingVariableError extends Error {
  constructor(readonly variableName: string) {
    super(
      `Variable "${variableName}" has no value. Declare it on the test, set it in the environment, or capture it in an earlier step.`,
    );
    this.name = 'MissingVariableError';
  }
}

/**
 * Replaces every `{{expression}}` in a template.
 *
 * An expression is a source followed by zero or more filters:
 * `{{ order.id | upper }}`, `{{ $randomInt(1,99) }}`, `{{ env:API_TOKEN }}`,
 * `{{ missing | default("n/a") }}`.
 */
export function interpolate(
  template: string,
  scope: VariableScope,
  options: InterpolateOptions = {},
): string {
  if (!template.includes('{{')) {
    return template;
  }

  return template.replace(PLACEHOLDER, (_match, expression: string) => {
    const value = evaluateExpression(expression, scope, options);

    if (value === undefined) {
      return handleMissing(expression, options);
    }

    return stringify(value);
  });
}

/**
 * Like `interpolate`, but a template that is exactly one placeholder keeps the
 * resolved value's real type. Numbers stay numbers and objects stay objects,
 * which matters for repeat counts and data-row bindings.
 */
export function resolveTyped(
  template: string,
  scope: VariableScope,
  options: InterpolateOptions = {},
): JsonValue {
  const trimmed = template.trim();
  const single = /^\{\{([^{}]+)\}\}$/.exec(trimmed);

  if (single?.[1] !== undefined) {
    const value = evaluateExpression(single[1], scope, options);

    if (value === undefined) {
      const fallback = handleMissing(single[1], options);
      return fallback;
    }

    return value;
  }

  return interpolate(template, scope, options);
}

/** Variable names a template depends on — powers editor autocomplete and validation. */
export function collectVariableNames(template: string): string[] {
  const names = new Set<string>();

  for (const match of template.matchAll(PLACEHOLDER)) {
    const expression = match[1];

    if (expression === undefined) {
      continue;
    }

    const [source = ''] = splitPipes(expression);
    const trimmed = source.trim();

    if (trimmed.startsWith('$') || trimmed.startsWith('env:')) {
      continue;
    }

    const [root = ''] = trimmed.split(/[.[]/);

    if (root.length > 0) {
      names.add(root);
    }
  }

  return [...names].sort();
}

function handleMissing(expression: string, options: InterpolateOptions): string {
  const behaviour = options.onMissing ?? 'throw';
  const name = expression.trim().split(/[.[|\s]/)[0] ?? expression.trim();

  if (behaviour === 'throw') {
    throw new MissingVariableError(name);
  }

  return behaviour === 'keep' ? `{{${expression}}}` : '';
}

function evaluateExpression(
  expression: string,
  scope: VariableScope,
  options: InterpolateOptions,
): JsonValue | undefined {
  const [sourceExpression = '', ...filters] = splitPipes(expression);
  let value = readSource(sourceExpression.trim(), scope, options);

  for (const filter of filters) {
    value = applyFilter(filter.trim(), value);
  }

  return value;
}

function readSource(
  source: string,
  scope: VariableScope,
  options: InterpolateOptions,
): JsonValue | undefined {
  if (source.startsWith('$')) {
    return callGenerator(source);
  }

  if (source.startsWith('env:')) {
    return process.env[source.slice(4).trim()] ?? undefined;
  }

  const [root = '', ...restPath] = splitPath(source);
  const overrides = options.overrides ?? {};
  const base = Object.prototype.hasOwnProperty.call(overrides, root) ? overrides[root] : scope.get(root);

  if (base === undefined) {
    return undefined;
  }

  return restPath.length === 0 ? base : readPath(base, restPath);
}

/** Splits `a.b[0].c` into `['a','b','0','c']`. */
export function splitPath(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function readPath(value: JsonValue, segments: string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }

    if (typeof current === 'object') {
      current = (current as Record<string, JsonValue>)[segment];
      continue;
    }

    return undefined;
  }

  return current;
}

/** Splits on `|` while respecting quoted filter arguments. */
function splitPipes(expression: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;

  for (const character of expression) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      current += character;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }

    if (character === '|') {
      parts.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  parts.push(current);

  return parts;
}

function parseCall(source: string): { name: string; args: string[] } {
  const match = /^([$A-Za-z_][\w$]*)\s*(?:\((.*)\))?$/.exec(source.trim());

  if (!match?.[1]) {
    return { name: source.trim(), args: [] };
  }

  return { name: match[1], args: parseArgs(match[2] ?? '') };
}

function parseArgs(raw: string): string[] {
  if (raw.trim().length === 0) {
    return [];
  }

  const args: string[] = [];
  let current = '';
  let quote: string | undefined;

  for (const character of raw) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += character;
  }

  args.push(current.trim());

  return args.filter((arg) => arg.length > 0 || args.length === 1);
}

/**
 * Built-in value generators. These make forms parameterisable without any
 * scripting: unique emails per run, incrementing names, timestamps, and so on.
 */
function callGenerator(source: string): JsonValue | undefined {
  const { name, args } = parseCall(source);
  const now = new Date();

  switch (name) {
    case '$uuid':
      return randomUUID();
    case '$timestamp':
      return Date.now();
    case '$isoDate':
      return now.toISOString();
    case '$date':
      return now.toISOString().slice(0, 10);
    case '$time':
      return now.toISOString().slice(11, 19);
    case '$randomInt': {
      const min = Number(args[0] ?? 0);
      const max = Number(args[1] ?? 1000);
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    case '$randomString': {
      const length = Number(args[0] ?? 8);
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let output = '';
      for (let index = 0; index < length; index += 1) {
        output += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      return output;
    }
    case '$randomEmail':
      return `flowcase+${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}@example.com`;
    default:
      return undefined;
  }
}

function applyFilter(filter: string, value: JsonValue | undefined): JsonValue | undefined {
  const { name, args } = parseCall(filter);
  const text = value === undefined || value === null ? '' : stringify(value);

  switch (name) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'trim':
      return text.trim();
    case 'urlencode':
      return encodeURIComponent(text);
    case 'json':
      return JSON.stringify(value ?? null);
    case 'number': {
      const parsed = Number(text);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    case 'int': {
      const parsed = Number.parseInt(text, 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    case 'slice':
      return text.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
    case 'replace':
      return text.split(args[0] ?? '').join(args[1] ?? '');
    case 'padStart':
      return text.padStart(Number(args[0] ?? 0), args[1] ?? '0');
    case 'default':
      return value === undefined || value === null || text.length === 0 ? (args[0] ?? '') : value;
    default:
      return value;
  }
}

function stringify(value: JsonValue): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}
