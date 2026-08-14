import { STEP_CATALOG } from './catalog.js';
import type { Step } from './step.js';
import { walkSteps } from './step.js';
import type { Snippet, TestCase } from './test.js';

export interface ValidationIssue {
  /** Step the issue belongs to; absent for test-level issues. */
  stepId?: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Checks a step against its catalog definition. The no-code editor calls this on
 * every keystroke to show inline problems, and the engine calls it before a run
 * so a half-built step fails with a clear message instead of a Playwright stack
 * trace.
 */
export function validateStep(step: Step): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definition = STEP_CATALOG[step.kind];

  if (!definition) {
    return [{ stepId: step.id, field: 'kind', message: `Unknown step type "${step.kind}".`, severity: 'error' }];
  }

  if (definition.needsTarget && !step.target) {
    issues.push({ stepId: step.id, field: 'target', message: `${definition.label} needs an element to act on.`, severity: 'error' });
  }

  if (definition.value?.required && (step.value ?? '').trim().length === 0) {
    issues.push({ stepId: step.id, field: 'value', message: `${definition.value.label} is required.`, severity: 'error' });
  }

  if (definition.value2?.required && (step.value2 ?? '').trim().length === 0) {
    issues.push({ stepId: step.id, field: 'value2', message: `${definition.value2.label} is required.`, severity: 'error' });
  }

  const numericField = definition.value?.kind === 'number' || definition.value?.kind === 'duration';

  if (numericField && definition.value && (step.value ?? '').trim().length > 0) {
    // Variables are resolved at run time, so only reject literal non-numbers.
    const raw = step.value ?? '';
    if (!raw.includes('{{') && Number.isNaN(Number(raw))) {
      issues.push({ stepId: step.id, field: 'value', message: `${definition.value.label} must be a number.`, severity: 'error' });
    }
  }

  if (definition.needsTarget && step.target && step.target.candidates.length === 0) {
    issues.push({ stepId: step.id, field: 'target', message: 'The element has no selectors left. Add one or re-record the step.', severity: 'error' });
  }

  if (step.target) {
    for (const candidate of step.target.candidates) {
      if (candidate.value.trim().length === 0) {
        issues.push({ stepId: step.id, field: 'target', message: 'A selector is empty — fill it in or remove it.', severity: 'error' });
        break;
      }
    }
  }

  if (step.kind === 'mockRoute' && step.mock && step.mock.urlPattern.trim().length === 0) {
    issues.push({ stepId: step.id, field: 'mock.urlPattern', message: 'Give the mocked route a URL pattern.', severity: 'error' });
  }

  if (step.kind === 'upload' && step.files.length === 0) {
    issues.push({ stepId: step.id, field: 'files', message: 'Choose at least one file to upload.', severity: 'error' });
  }

  if (step.kind === 'snippet' && !step.snippetId) {
    issues.push({ stepId: step.id, field: 'snippetId', message: 'Choose a snippet to insert.', severity: 'error' });
  }

  if (step.kind === 'mockRoute' && !step.mock) {
    issues.push({ stepId: step.id, field: 'mock', message: 'Configure the route to mock.', severity: 'error' });
  }

  if (step.kind === 'extract' && step.extract.length === 0) {
    issues.push({ stepId: step.id, field: 'extract', message: 'Add at least one value to capture.', severity: 'error' });
  }

  for (const rule of step.extract) {
    if (rule.name.trim().length === 0) {
      issues.push({ stepId: step.id, field: 'extract.name', message: 'Captured values need a variable name.', severity: 'error' });
    }

    const needsTarget = rule.from === 'text' || rule.from === 'attribute' || rule.from === 'inputValue' || rule.from === 'count';
    if (needsTarget && !rule.target) {
      issues.push({ stepId: step.id, field: 'extract.target', message: `Capturing from ${rule.from} needs an element.`, severity: 'error' });
    }

    if (rule.from === 'attribute' && !rule.attribute) {
      issues.push({ stepId: step.id, field: 'extract.attribute', message: 'Name the attribute to read.', severity: 'error' });
    }

    if (rule.from === 'response' && !rule.urlPattern) {
      issues.push({ stepId: step.id, field: 'extract.urlPattern', message: 'Give a URL pattern for the response to capture.', severity: 'error' });
    }

    if (rule.pattern) {
      try {
        new RegExp(rule.pattern);
      } catch {
        issues.push({ stepId: step.id, field: 'extract.pattern', message: `"${rule.pattern}" is not a valid regular expression.`, severity: 'error' });
      }
    }
  }

  if (step.repeat) {
    const { mode, count, countVariable, dataSet, conditionTarget } = step.repeat;

    if (mode === 'fixed' && (count === undefined || count < 0)) {
      issues.push({ stepId: step.id, field: 'repeat.count', message: 'Set how many times to repeat.', severity: 'error' });
    }

    if (mode === 'variable' && !countVariable) {
      issues.push({ stepId: step.id, field: 'repeat.countVariable', message: 'Choose the variable holding the repeat count.', severity: 'error' });
    }

    if (mode === 'data' && !dataSet) {
      issues.push({ stepId: step.id, field: 'repeat.dataSet', message: 'Choose the data set to iterate.', severity: 'error' });
    }

    if (mode === 'while' && !conditionTarget) {
      issues.push({ stepId: step.id, field: 'repeat.conditionTarget', message: 'Choose the element the loop condition watches.', severity: 'error' });
    }

    if (!STEP_CATALOG[step.kind].supportsRepeat) {
      issues.push({ stepId: step.id, field: 'repeat', message: `${definition.label} cannot be repeated.`, severity: 'warning' });
    }
  }

  if (step.matcher === 'regex' && (step.value ?? '').length > 0 && !(step.value ?? '').includes('{{')) {
    try {
      new RegExp(step.value ?? '');
    } catch {
      issues.push({ stepId: step.id, field: 'value', message: 'Expected value is not a valid regular expression.', severity: 'error' });
    }
  }

  return issues;
}

/** Validates a whole test: every step, plus test-level references. */
export function validateTest(test: TestCase, options: { snippetIds?: Set<string> } = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (test.name.trim().length === 0) {
    issues.push({ field: 'name', message: 'Give the test a name.', severity: 'error' });
  }

  if (test.steps.length === 0) {
    issues.push({ field: 'steps', message: 'The test has no steps yet.', severity: 'warning' });
  }

  const dataSetNames = new Set(test.dataSets.map((set) => set.name));

  if (test.dataDrivenSet && !dataSetNames.has(test.dataDrivenSet)) {
    issues.push({ field: 'dataDrivenSet', message: `Data set "${test.dataDrivenSet}" does not exist on this test.`, severity: 'error' });
  }

  if (test.dependsOn.includes(test.id)) {
    issues.push({ field: 'dependsOn', message: 'A test cannot depend on itself.', severity: 'error' });
  }

  for (const variable of test.variables) {
    if (variable.name.trim().length === 0) {
      issues.push({ field: 'variables', message: 'Every variable needs a name.', severity: 'error' });
      break;
    }
  }

  for (const set of test.dataSets) {
    if (set.name.trim().length === 0) {
      issues.push({ field: 'dataSets', message: 'Every data set needs a name.', severity: 'error' });
      break;
    }
  }

  for (const step of walkSteps(test.steps)) {
    issues.push(...validateStep(step));

    if (step.repeat?.mode === 'data' && step.repeat.dataSet && !dataSetNames.has(step.repeat.dataSet)) {
      issues.push({ stepId: step.id, field: 'repeat.dataSet', message: `Data set "${step.repeat.dataSet}" does not exist on this test.`, severity: 'error' });
    }

    if (step.kind === 'snippet' && step.snippetId && options.snippetIds && !options.snippetIds.has(step.snippetId)) {
      issues.push({ stepId: step.id, field: 'snippetId', message: 'The referenced snippet no longer exists.', severity: 'error' });
    }
  }

  return issues;
}

export function validateSnippet(snippet: Snippet): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (snippet.name.trim().length === 0) {
    issues.push({ field: 'name', message: 'Give the snippet a name.', severity: 'error' });
  }

  for (const step of walkSteps(snippet.steps)) {
    if (step.kind === 'snippet') {
      issues.push({ stepId: step.id, field: 'kind', message: 'Snippets cannot contain other snippets.', severity: 'error' });
      continue;
    }

    issues.push(...validateStep(step));
  }

  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => (issue.stepId ? `${issue.stepId}: ${issue.message}` : issue.message))
    .join('\n');
}
