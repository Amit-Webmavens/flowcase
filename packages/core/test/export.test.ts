import { describe, expect, it } from 'vitest';
import { exportToPlaywright } from '../src/export/playwright.js';
import { createEnvironment, createSnippet, createStep, createTest } from '../src/model/factory.js';
import type { Target } from '../src/model/selector.js';

const testId = (value: string, description: string): Target => ({
  candidates: [{ engine: 'testid', value, score: 100, source: 'recorded' }],
  primaryIndex: 0,
  frame: [],
  inShadowDom: false,
  description,
});

const role = (name: string): Target => ({
  candidates: [{ engine: 'role', value: 'button', name, exact: true, score: 85, source: 'recorded' }],
  primaryIndex: 0,
  frame: [],
  inShadowDom: false,
});

const environment = createEnvironment({ name: 'staging', baseUrl: 'https://staging.example.com' });

describe('exportToPlaywright', () => {
  it('produces a runnable-looking spec with the standard imports', () => {
    const code = exportToPlaywright(createTest({ name: 'Create an order' }), { environment });

    expect(code).toContain("import { expect, test } from '@playwright/test';");
    expect(code).toContain("test('Create an order', async ({ page }) => {");
    expect(code).toContain("const baseUrl = process.env.BASE_URL ?? 'https://staging.example.com';");
  });

  it('renders navigation against the base URL', () => {
    const test = createTest({ name: 'T', steps: [createStep('goto', { value: '/orders' })] });

    expect(exportToPlaywright(test, { environment })).toContain("await page.goto(baseUrl + '/orders');");
  });

  it('leaves absolute URLs alone', () => {
    const test = createTest({ name: 'T', steps: [createStep('goto', { value: 'https://other.test/x' })] });

    expect(exportToPlaywright(test, { environment })).toContain("await page.goto('https://other.test/x');");
  });

  it('maps locators to the matching getBy helper', () => {
    const test = createTest({
      name: 'T',
      steps: [createStep('click', { target: testId('save', 'Save') }), createStep('click', { target: role('Cancel') })],
    });

    const code = exportToPlaywright(test);

    expect(code).toContain("page.getByTestId('save').click()");
    expect(code).toContain("page.getByRole('button', { name: 'Cancel', exact: true }).click()");
  });

  it('turns variables into template interpolation of the vars object', () => {
    const test = createTest({
      name: 'T',
      steps: [createStep('fill', { target: testId('name', 'Name'), value: 'Order {{orderId}}' })],
    });

    expect(exportToPlaywright(test)).toContain("fill(`Order ${vars['orderId'] ?? ''}`)");
  });

  it('renders assertions as expect calls', () => {
    const test = createTest({
      name: 'T',
      steps: [
        createStep('assertText', { target: testId('result', 'Result'), value: 'Done', matcher: 'contains' }),
        createStep('assertText', { target: testId('result', 'Result'), value: 'Exactly', matcher: 'equals' }),
        createStep('assertVisible', { target: testId('result', 'Result') }),
      ],
    });

    const code = exportToPlaywright(test);

    expect(code).toContain("toContainText('Done')");
    expect(code).toContain("toHaveText('Exactly')");
    expect(code).toContain('toBeVisible()');
  });

  it('renders a captured value as an assignment', () => {
    const test = createTest({
      name: 'T',
      steps: [
        createStep('extract', {
          extract: [{ name: 'orderId', from: 'url', pattern: '/orders/(\\d+)', group: 1, scope: 'run', required: true }],
        }),
      ],
    });

    const code = exportToPlaywright(test);

    expect(code).toContain("vars['orderId'] =");
    expect(code).toContain('page.url()');
    expect(code).toContain('/\\/orders\\/(\\d+)/');
  });

  it('renders a fixed repeat as a for loop', () => {
    const test = createTest({
      name: 'T',
      steps: [
        createStep('click', {
          target: testId('add', 'Add'),
          repeat: { mode: 'fixed', count: 3, max: 100, indexVariable: '_index', itemVariable: 'row', stopOnFailure: true },
        }),
      ],
    });

    const code = exportToPlaywright(test);

    expect(code).toContain('for (let i0 = 0; i0 < 3; i0++) {');
    expect(code).toContain("page.getByTestId('add').click()");
  });

  it('wraps a group in test.step', () => {
    const test = createTest({
      name: 'T',
      steps: [createStep('group', { value: 'Add a line item', children: [createStep('reload')] })],
    });

    expect(exportToPlaywright(test)).toContain("await test.step('Add a line item', async () => {");
  });

  it('inlines a snippet rather than referencing it', () => {
    const snippet = createSnippet({ name: 'Log in', steps: [createStep('goto', { value: '/login' })] });
    const test = createTest({ name: 'T', steps: [createStep('snippet', { snippetId: snippet.id })] });

    const code = exportToPlaywright(test, { snippets: new Map([[snippet.id, snippet]]), environment });

    expect(code).toContain("await test.step('Log in'");
    expect(code).toContain("baseUrl + '/login'");
  });

  it('comments out a disabled step instead of emitting it', () => {
    const test = createTest({
      name: 'T',
      steps: [createStep('click', { target: testId('save', 'Save'), enabled: false })],
    });

    const code = exportToPlaywright(test);

    expect(code).toContain('// (disabled)');
    expect(code).not.toContain('.click()');
  });

  it('escapes quotes so the output stays valid', () => {
    const test = createTest({
      name: "Tester's flow",
      steps: [createStep('fill', { target: testId('name', 'Name'), value: "O'Brien" })],
    });

    const code = exportToPlaywright(test);

    expect(code).toContain("test('Tester\\'s flow'");
    expect(code).toContain("fill('O\\'Brien')");
  });
});
