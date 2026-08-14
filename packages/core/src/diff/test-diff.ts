import type { JsonValue } from '../model/common.js';
import { summarizeStep } from '../model/catalog.js';
import { describeTarget } from '../model/selector.js';
import type { Step } from '../model/step.js';
import type { TestCase } from '../model/test.js';
import { stableStringify } from '../storage/fs-utils.js';

export interface FieldChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

export type StepChangeKind = 'added' | 'removed' | 'changed' | 'moved' | 'unchanged';

export interface StepDiff {
  stepId: string;
  kind: StepChangeKind;
  label: string;
  /** Label as it read in the older version, when it changed. */
  previousLabel?: string;
  beforeIndex?: number;
  afterIndex?: number;
  depth: number;
  changes: FieldChange[];
}

export interface TestDiff {
  fields: FieldChange[];
  steps: StepDiff[];
  summary: { added: number; removed: number; changed: number; moved: number };
}

interface FlatStep {
  step: Step;
  index: number;
  depth: number;
}

function flatten(steps: Step[], depth = 0, output: FlatStep[] = []): FlatStep[] {
  for (const step of steps) {
    output.push({ step, index: output.length, depth });
    flatten(step.children, depth + 1, output);
  }

  return output;
}

/** Step fields worth showing in a review, in the order a reader expects them. */
const STEP_FIELDS: Array<{ key: keyof Step | 'target'; label: string }> = [
  { key: 'kind', label: 'Action' },
  { key: 'target', label: 'Element' },
  { key: 'value', label: 'Value' },
  { key: 'value2', label: 'Second value' },
  { key: 'matcher', label: 'Comparison' },
  { key: 'enabled', label: 'Enabled' },
  { key: 'onFailure', label: 'On failure' },
  { key: 'timeoutMs', label: 'Timeout' },
  { key: 'retry', label: 'Retry policy' },
  { key: 'repeat', label: 'Repeat' },
  { key: 'extract', label: 'Captured values' },
  { key: 'files', label: 'Files' },
  { key: 'mock', label: 'Network mock' },
  { key: 'visual', label: 'Visual check' },
  { key: 'note', label: 'Note' },
];

function renderField(step: Step, key: keyof Step | 'target'): string {
  if (key === 'target') {
    return step.target ? describeTarget(step.target) : '';
  }

  const value = step[key] as JsonValue | undefined;

  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'object') {
    return Array.isArray(value) && value.length === 0 ? '' : stableStringify(value);
  }

  return String(value);
}

/**
 * Compares two versions of a test.
 *
 * Steps are matched by id, so a step that moved is reported as moved rather than
 * as a delete plus an add. This is what the version history and the approval
 * review screen render — a reviewer needs to see exactly what a tester changed.
 */
export function diffTests(before: TestCase, after: TestCase): TestDiff {
  const fields: FieldChange[] = [];

  const compare = (field: string, label: string, left: unknown, right: unknown): void => {
    const leftText = typeof left === 'object' ? stableStringify(left) : String(left ?? '');
    const rightText = typeof right === 'object' ? stableStringify(right) : String(right ?? '');

    if (leftText !== rightText) {
      fields.push({ field, label, before: leftText, after: rightText });
    }
  };

  compare('name', 'Name', before.name, after.name);
  compare('description', 'Description', before.description, after.description);
  compare('tags', 'Tags', before.tags, after.tags);
  compare('dependsOn', 'Depends on', before.dependsOn, after.dependsOn);
  compare('variables', 'Variables', before.variables, after.variables);
  compare('dataSets', 'Data sets', before.dataSets, after.dataSets);
  compare('dataDrivenSet', 'Data-driven set', before.dataDrivenSet, after.dataDrivenSet);
  compare('environmentId', 'Environment', before.environmentId, after.environmentId);
  compare('mocks', 'Network mocks', before.mocks, after.mocks);
  compare('auth', 'Session handling', before.auth, after.auth);
  compare('defaultRetry', 'Default retry', before.defaultRetry, after.defaultRetry);
  compare('defaultTimeoutMs', 'Default timeout', before.defaultTimeoutMs, after.defaultTimeoutMs);

  const beforeSteps = flatten(before.steps);
  const afterSteps = flatten(after.steps);
  const beforeById = new Map(beforeSteps.map((entry) => [entry.step.id, entry]));
  const afterById = new Map(afterSteps.map((entry) => [entry.step.id, entry]));

  const steps: StepDiff[] = [];
  const summary = { added: 0, removed: 0, changed: 0, moved: 0 };

  for (const entry of afterSteps) {
    const previous = beforeById.get(entry.step.id);

    if (!previous) {
      steps.push({
        stepId: entry.step.id,
        kind: 'added',
        label: summarizeStep(entry.step),
        afterIndex: entry.index,
        depth: entry.depth,
        changes: [],
      });
      summary.added += 1;
      continue;
    }

    const changes: FieldChange[] = [];

    for (const field of STEP_FIELDS) {
      const left = renderField(previous.step, field.key);
      const right = renderField(entry.step, field.key);

      if (left !== right) {
        changes.push({ field: String(field.key), label: field.label, before: left, after: right });
      }
    }

    const moved = previous.index !== entry.index;
    const kind: StepChangeKind = changes.length > 0 ? 'changed' : moved ? 'moved' : 'unchanged';

    if (kind === 'changed') {
      summary.changed += 1;
    } else if (kind === 'moved') {
      summary.moved += 1;
    }

    steps.push({
      stepId: entry.step.id,
      kind,
      label: summarizeStep(entry.step),
      ...(changes.length > 0 ? { previousLabel: summarizeStep(previous.step) } : {}),
      beforeIndex: previous.index,
      afterIndex: entry.index,
      depth: entry.depth,
      changes,
    });
  }

  for (const entry of beforeSteps) {
    if (!afterById.has(entry.step.id)) {
      steps.push({
        stepId: entry.step.id,
        kind: 'removed',
        label: summarizeStep(entry.step),
        beforeIndex: entry.index,
        depth: entry.depth,
        changes: [],
      });
      summary.removed += 1;
    }
  }

  steps.sort((a, b) => (a.afterIndex ?? a.beforeIndex ?? 0) - (b.afterIndex ?? b.beforeIndex ?? 0));

  return { fields, steps, summary };
}
