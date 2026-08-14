import { describe, expect, it } from 'vitest';
import { diffTests } from '../src/diff/test-diff.js';
import { inlineSnippets, referencedSnippetIds } from '../src/engine/inline.js';
import { summarizeStep } from '../src/model/catalog.js';
import { createSnippet, createStep, createTest } from '../src/model/factory.js';
import type { Target } from '../src/model/selector.js';
import { hasErrors, validateStep, validateTest } from '../src/model/validate.js';

const target: Target = {
  candidates: [{ engine: 'testid', value: 'save', score: 100, source: 'recorded' }],
  primaryIndex: 0,
  frame: [],
  inShadowDom: false,
  description: 'button "Save"',
};

describe('validateStep', () => {
  it('requires an element for steps that act on one', () => {
    const issues = validateStep(createStep('click'));

    expect(hasErrors(issues)).toBe(true);
    expect(issues[0]?.field).toBe('target');
  });

  it('accepts a complete step', () => {
    expect(validateStep(createStep('click', { target }))).toEqual([]);
  });

  it('requires a URL on a navigation step', () => {
    expect(hasErrors(validateStep(createStep('goto')))).toBe(true);
    expect(hasErrors(validateStep(createStep('goto', { value: '/orders' })))).toBe(false);
  });

  it('rejects a non-numeric literal in a numeric field but allows a variable', () => {
    expect(hasErrors(validateStep(createStep('waitForTimeout', { value: 'soon' })))).toBe(true);
    expect(hasErrors(validateStep(createStep('waitForTimeout', { value: '{{delay}}' })))).toBe(false);
  });

  it('rejects an invalid regular expression', () => {
    const step = createStep('assertText', { target, value: '([', matcher: 'regex' });

    expect(hasErrors(validateStep(step))).toBe(true);
  });

  it('checks repeat configuration', () => {
    const missingDataSet = createStep('click', {
      target,
      repeat: { mode: 'data', max: 100, indexVariable: '_index', itemVariable: 'row', stopOnFailure: true },
    });

    expect(hasErrors(validateStep(missingDataSet))).toBe(true);
  });

  it('checks capture rules', () => {
    const step = createStep('extract', {
      extract: [{ name: '', from: 'url', group: 1, scope: 'run', required: true }],
    });

    expect(hasErrors(validateStep(step))).toBe(true);
  });
});

describe('validateTest', () => {
  it('flags a data set that does not exist', () => {
    const test = createTest({ name: 'Data', dataDrivenSet: 'missing' });

    expect(hasErrors(validateTest(test))).toBe(true);
  });

  it('flags a test depending on itself', () => {
    const test = createTest({ name: 'Self' });
    test.dependsOn = [test.id];

    expect(hasErrors(validateTest(test))).toBe(true);
  });

  it('flags a snippet reference that no longer resolves', () => {
    const test = createTest({ name: 'Broken', steps: [createStep('snippet', { snippetId: 'sn_gone' })] });

    expect(hasErrors(validateTest(test, { snippetIds: new Set() }))).toBe(true);
  });
});

describe('summarizeStep', () => {
  it('describes steps in plain language', () => {
    expect(summarizeStep(createStep('goto', { value: '/orders' }))).toBe('Go to /orders');
    expect(summarizeStep(createStep('click', { target }))).toBe('Click button "Save"');
    expect(summarizeStep(createStep('fill', { target, value: 'Ada' }))).toBe('Fill field button "Save" with "Ada"');
    expect(summarizeStep(createStep('assertText', { target, value: 'Done', matcher: 'contains' }))).toBe(
      'Expect button "Save" to contain "Done"',
    );
  });

  it('prefers an explicit label when one is set', () => {
    expect(summarizeStep(createStep('click', { target, label: 'Submit the order' }))).toBe('Submit the order');
  });
});

describe('inlineSnippets', () => {
  const snippet = createSnippet({
    name: 'Log in',
    parameters: [{ name: 'email', type: 'string', defaultValue: 'a@b.c', required: false, source: 'input' }],
    steps: [createStep('fill', { target, value: '{{email}}' }), createStep('click', { target })],
  });

  it('replaces a snippet step with a group holding its steps', () => {
    const steps = inlineSnippets([createStep('snippet', { snippetId: snippet.id })], new Map([[snippet.id, snippet]]));

    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe('group');
    expect(steps[0]?.children).toHaveLength(2);
    expect(steps[0]?.label).toBe('Log in');
  });

  it('binds arguments over the snippet defaults', () => {
    const steps = inlineSnippets(
      [createStep('snippet', { snippetId: snippet.id, snippetArgs: { email: 'grace@example.com' } })],
      new Map([[snippet.id, snippet]]),
    );

    expect(steps[0]?.snippetArgs).toEqual({ email: 'grace@example.com' });
  });

  it('gives each expansion distinct step ids', () => {
    const steps = inlineSnippets(
      [createStep('snippet', { snippetId: snippet.id }), createStep('snippet', { snippetId: snippet.id })],
      new Map([[snippet.id, snippet]]),
    );

    const first = steps[0]?.children.map((step) => step.id) ?? [];
    const second = steps[1]?.children.map((step) => step.id) ?? [];

    expect(first).not.toEqual(second);
  });

  it('leaves an unresolved snippet in place for validation to report', () => {
    const steps = inlineSnippets([createStep('snippet', { snippetId: 'sn_gone' })], new Map());

    expect(steps[0]?.kind).toBe('snippet');
  });

  it('lists referenced snippet ids, including nested ones', () => {
    const steps = [createStep('group', { children: [createStep('snippet', { snippetId: snippet.id })] })];

    expect(referencedSnippetIds(steps)).toEqual([snippet.id]);
  });
});

describe('diffTests', () => {
  it('reports an added step', () => {
    const before = createTest({ name: 'T', steps: [createStep('goto', { value: '/' })] });
    const after = { ...before, steps: [...before.steps, createStep('reload')] };

    const diff = diffTests(before, after);

    expect(diff.summary.added).toBe(1);
    expect(diff.summary.removed).toBe(0);
  });

  it('reports a changed field on a step', () => {
    const step = createStep('goto', { value: '/' });
    const before = createTest({ name: 'T', steps: [step] });
    const after = { ...before, steps: [{ ...step, value: '/orders' }] };

    const diff = diffTests(before, after);

    expect(diff.summary.changed).toBe(1);
    expect(diff.steps[0]?.changes[0]?.before).toBe('/');
    expect(diff.steps[0]?.changes[0]?.after).toBe('/orders');
  });

  it('reports a reordered step as moved, not as add plus remove', () => {
    const first = createStep('goto', { value: '/' });
    const second = createStep('reload');
    const before = createTest({ name: 'T', steps: [first, second] });
    const after = { ...before, steps: [second, first] };

    const diff = diffTests(before, after);

    expect(diff.summary.moved).toBe(2);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
  });

  it('reports test-level setting changes', () => {
    const before = createTest({ name: 'Old name', tags: ['a'] });
    const after = { ...before, name: 'New name', tags: ['a', 'b'] };

    const diff = diffTests(before, after);

    expect(diff.fields.map((field) => field.field).sort()).toEqual(['name', 'tags']);
  });
});
