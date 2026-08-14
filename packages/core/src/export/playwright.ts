import { summarizeStep } from '../model/catalog.js';
import type { SelectorCandidate, Target } from '../model/selector.js';
import type { Step } from '../model/step.js';
import type { Environment, Snippet, TestCase } from '../model/test.js';
import { inlineSnippets } from '../engine/inline.js';

export interface ExportOptions {
  snippets?: Map<string, Snippet>;
  environment?: Environment | undefined;
  /** Emit each step's note as a code comment. */
  includeNotes?: boolean;
  /** Wrap groups in `test.step()` so they show up in Playwright's report. */
  useTestSteps?: boolean;
}

/**
 * Renders a test as a standalone Playwright spec.
 *
 * The output has no dependency on flowcase — it is an ordinary `@playwright/test`
 * file that can be committed and run by any Playwright setup. This is the escape
 * hatch: teams are never locked into the no-code tool, and an engineer can take
 * a recorded flow and keep editing it as code.
 */
export function exportToPlaywright(test: TestCase, options: ExportOptions = {}): string {
  const { includeNotes = true, useTestSteps = true } = options;
  const steps = inlineSnippets(test.steps, options.snippets ?? new Map());

  const context: EmitContext = {
    lines: [],
    indent: 2,
    includeNotes,
    useTestSteps,
    declaredVariables: new Set<string>(),
    loopDepth: 0,
  };

  emitSteps(steps, context);

  const header: string[] = [
    "import { expect, test } from '@playwright/test';",
    '',
    `// Exported from flowcase — "${test.name}" (version ${test.version}).`,
    '// This file is plain Playwright: edit and run it without flowcase installed.',
    '',
  ];

  const baseUrl = options.environment?.baseUrl ?? '';

  if (baseUrl.length > 0) {
    header.push(`const baseUrl = process.env.BASE_URL ?? ${quote(baseUrl)};`);
  }

  const variableEntries = buildVariableSeed(test, options.environment);

  if (variableEntries.length > 0) {
    header.push('');
    header.push('/** Test inputs. Override any of these from the environment. */');
    header.push('const vars: Record<string, string> = {');
    header.push(...variableEntries.map((entry) => `  ${entry},`));
    header.push('};');
  } else {
    header.push('');
    header.push('const vars: Record<string, string> = {};');
  }

  if (test.dependsOn.length > 0) {
    header.push('');
    header.push('// This test depended on other flowcase tests. Their steps are not included here —');
    header.push('// export them too, or use a Playwright fixture to set up the same state.');
  }

  const body = [
    '',
    `test(${quote(test.name)}, async ({ page }) => {`,
    ...context.lines,
    '});',
    '',
  ];

  return [...header, ...body].join('\n');
}

interface EmitContext {
  lines: string[];
  indent: number;
  includeNotes: boolean;
  useTestSteps: boolean;
  declaredVariables: Set<string>;
  loopDepth: number;
}

function push(context: EmitContext, line: string): void {
  context.lines.push(line.length > 0 ? `${' '.repeat(context.indent)}${line}` : '');
}

function emitSteps(steps: Step[], context: EmitContext): void {
  for (const step of steps) {
    if (!step.enabled) {
      push(context, `// (disabled) ${summarizeStep(step)}`);
      continue;
    }

    if (step.kind === 'comment') {
      push(context, `// ${step.value ?? ''}`);
      continue;
    }

    if (context.includeNotes && step.note) {
      for (const line of step.note.split('\n')) {
        push(context, `// ${line}`);
      }
    }

    emitStepWithRepeat(step, context);
  }
}

function emitStepWithRepeat(step: Step, context: EmitContext): void {
  const repeat = step.repeat;

  if (!repeat) {
    emitStep(step, context);
    return;
  }

  const loopVariable = `i${context.loopDepth}`;
  context.loopDepth += 1;

  switch (repeat.mode) {
    case 'fixed':
      push(context, `for (let ${loopVariable} = 0; ${loopVariable} < ${repeat.count ?? 0}; ${loopVariable}++) {`);
      break;
    case 'variable':
      push(
        context,
        `for (let ${loopVariable} = 0; ${loopVariable} < Number(vars[${quote(repeat.countVariable ?? '')}] ?? 0); ${loopVariable}++) {`,
      );
      break;
    case 'data':
      push(context, `// Rows came from the flowcase data set "${repeat.dataSet ?? ''}".`);
      push(context, `for (const row of dataRows) {`);
      break;
    case 'while':
      push(context, `for (let ${loopVariable} = 0; ${loopVariable} < ${repeat.max}; ${loopVariable}++) {`);
      break;
  }

  context.indent += 2;

  if (repeat.mode !== 'data') {
    push(context, `vars[${quote(repeat.indexVariable)}] = String(${loopVariable});`);
  }

  emitStep(step, context);

  context.indent -= 2;
  push(context, '}');
  context.loopDepth -= 1;
}

function emitStep(step: Step, context: EmitContext): void {
  const timeout = step.timeoutMs === undefined ? '' : `, { timeout: ${step.timeoutMs} }`;
  const locator = step.target ? locatorExpression(step.target) : 'page';

  switch (step.kind) {
    case 'group': {
      if (context.useTestSteps) {
        push(context, `await test.step(${quote(step.value || step.label || 'Group')}, async () => {`);
        context.indent += 2;
        emitSteps(step.children, context);
        context.indent -= 2;
        push(context, '});');
      } else {
        emitSteps(step.children, context);
      }
      return;
    }

    case 'goto':
      push(context, `await page.goto(${urlExpression(step.value ?? '')});`);
      return;

    case 'reload':
      push(context, 'await page.reload();');
      return;

    case 'goBack':
      push(context, 'await page.goBack();');
      return;

    case 'goForward':
      push(context, 'await page.goForward();');
      return;

    case 'setViewport':
      push(
        context,
        `await page.setViewportSize({ width: ${Number(step.value) || 1280}, height: ${Number(step.value2) || 720} });`,
      );
      return;

    case 'click':
      push(context, `await ${locator}.click(${timeout.slice(2)});`);
      return;

    case 'dblclick':
      push(context, `await ${locator}.dblclick();`);
      return;

    case 'rightClick':
      push(context, `await ${locator}.click({ button: 'right' });`);
      return;

    case 'fill':
      push(context, `await ${locator}.fill(${valueExpression(step.value ?? '')});`);
      return;

    case 'type':
      push(context, `await ${locator}.pressSequentially(${valueExpression(step.value ?? '')});`);
      return;

    case 'press':
      push(
        context,
        step.target
          ? `await ${locator}.press(${valueExpression(step.value ?? '')});`
          : `await page.keyboard.press(${valueExpression(step.value ?? '')});`,
      );
      return;

    case 'select':
      push(context, `await ${locator}.selectOption(${valueExpression(step.value ?? '')});`);
      return;

    case 'check':
      push(context, `await ${locator}.check();`);
      return;

    case 'uncheck':
      push(context, `await ${locator}.uncheck();`);
      return;

    case 'hover':
      push(context, `await ${locator}.hover();`);
      return;

    case 'focus':
      push(context, `await ${locator}.focus();`);
      return;

    case 'clear':
      push(context, `await ${locator}.clear();`);
      return;

    case 'upload':
      push(context, `await ${locator}.setInputFiles([${step.files.map(quote).join(', ')}]);`);
      return;

    case 'dragAndDrop':
      push(context, `await ${locator}.dragTo(page.locator(${valueExpression(step.value ?? '')}));`);
      return;

    case 'scrollTo':
      push(context, `await ${locator}.scrollIntoViewIfNeeded();`);
      return;

    case 'waitForSelector':
      push(context, `await ${locator}.waitFor({ state: 'visible'${step.timeoutMs ? `, timeout: ${step.timeoutMs}` : ''} });`);
      return;

    case 'waitForHidden':
      push(context, `await ${locator}.waitFor({ state: 'hidden' });`);
      return;

    case 'waitForUrl':
      push(context, `await page.waitForURL(${globExpression(step.value ?? '')});`);
      return;

    case 'waitForText':
      push(context, `await page.getByText(${valueExpression(step.value ?? '')}).first().waitFor();`);
      return;

    case 'waitForTimeout':
      push(context, `await page.waitForTimeout(${Number(step.value) || 0});`);
      return;

    case 'waitForResponse':
      push(context, `await page.waitForResponse(${globExpression(step.value ?? '')});`);
      return;

    case 'waitForLoadState':
      push(context, `await page.waitForLoadState(${quote(step.value || 'load')});`);
      return;

    case 'assertVisible':
      push(context, `await expect(${locator}).toBeVisible();`);
      return;

    case 'assertHidden':
      push(context, `await expect(${locator}).toBeHidden();`);
      return;

    case 'assertText':
      push(context, `await expect(${locator}).${textMatcher(step)};`);
      return;

    case 'assertValue':
      push(context, `await expect(${locator}).toHaveValue(${valueExpression(step.value ?? '')});`);
      return;

    case 'assertUrl':
      push(context, `await expect(page).toHaveURL(${step.matcher === 'regex' ? regexExpression(step.value ?? '') : globExpression(step.value ?? '')});`);
      return;

    case 'assertTitle':
      push(context, `await expect(page).toHaveTitle(${step.matcher === 'regex' ? regexExpression(step.value ?? '') : valueExpression(step.value ?? '')});`);
      return;

    case 'assertCount':
      push(context, `await expect(${locator}).toHaveCount(${Number(step.value) || 0});`);
      return;

    case 'assertAttribute':
      push(
        context,
        `await expect(${locator}).toHaveAttribute(${valueExpression(step.value ?? '')}, ${valueExpression(step.value2 ?? '')});`,
      );
      return;

    case 'assertChecked':
      push(context, `await expect(${locator}).toBeChecked();`);
      return;

    case 'assertEnabled':
      push(context, `await expect(${locator}).toBeEnabled();`);
      return;

    case 'assertDisabled':
      push(context, `await expect(${locator}).toBeDisabled();`);
      return;

    case 'extract':
      for (const rule of step.extract) {
        push(context, extractExpression(rule.name, rule, step));
      }
      return;

    case 'setVariable':
      push(context, `vars[${quote(step.value ?? '')}] = ${valueExpression(step.value2 ?? '')};`);
      return;

    case 'screenshot':
      push(context, `await page.screenshot({ path: ${quote(`${step.value || 'screenshot'}.png`)}, fullPage: true });`);
      return;

    case 'visualCheck':
      push(context, `await expect(page).toHaveScreenshot(${quote(`${step.value || step.id}.png`)});`);
      return;

    case 'mockRoute': {
      const mock = step.mock;

      if (!mock) {
        return;
      }

      push(context, `await page.route(${globExpression(mock.urlPattern)}, (route) =>`);
      context.indent += 2;
      push(
        context,
        mock.abort
          ? 'route.abort(),'
          : `route.fulfill({ status: ${mock.status}, contentType: ${quote(mock.contentType)}, body: ${quote(mock.body)} }),`,
      );
      context.indent -= 2;
      push(context, ');');
      return;
    }

    case 'unmockRoute':
      push(context, `await page.unroute(${globExpression(step.value ?? '')});`);
      return;

    case 'saveSession':
      push(context, `await page.context().storageState({ path: ${quote(`${step.value || 'session'}.json`)} });`);
      return;

    case 'loadSession':
      push(
        context,
        `// Load "${step.value ?? ''}" with a storageState option on the browser context instead —`,
      );
      push(context, '// Playwright cannot attach a session to a context that is already open.');
      return;

    case 'snippet':
      push(context, `// Unresolved snippet reference: ${step.snippetId ?? 'unknown'}`);
      return;

    case 'comment':
      return;
  }
}

function textMatcher(step: Step): string {
  const expected = valueExpression(step.value ?? '');

  switch (step.matcher) {
    case 'equals':
      return `toHaveText(${expected})`;
    case 'regex':
      return `toHaveText(${regexExpression(step.value ?? '')})`;
    case 'notContains':
      return `not.toContainText(${expected})`;
    default:
      return `toContainText(${expected})`;
  }
}

function extractExpression(name: string, rule: Step['extract'][number], step: Step): string {
  const assign = (expression: string): string => `vars[${quote(name)}] = ${expression};`;
  const locator = rule.target ? locatorExpression(rule.target) : 'page';

  const withPattern = (source: string): string =>
    rule.pattern
      ? `(${source}.match(${regexExpression(rule.pattern)})?.[${rule.group}] ?? '')`
      : source;

  switch (rule.from) {
    case 'url':
      return assign(withPattern('page.url()'));
    case 'title':
      return `vars[${quote(name)}] = ${withPattern('await page.title()')};`;
    case 'text':
      return `vars[${quote(name)}] = ${withPattern(`await ${locator}.innerText()`)};`;
    case 'inputValue':
      return `vars[${quote(name)}] = ${withPattern(`await ${locator}.inputValue()`)};`;
    case 'attribute':
      return `vars[${quote(name)}] = ${withPattern(`(await ${locator}.getAttribute(${quote(rule.attribute ?? '')})) ?? ''`)};`;
    case 'count':
      return `vars[${quote(name)}] = String(await ${locator}.count());`;
    case 'literal':
      return assign(valueExpression(rule.literal ?? ''));
    case 'response':
      return `// Capture "${name}" from a response matching ${rule.urlPattern ?? ''} using page.waitForResponse().`;
    case 'storage':
      return `vars[${quote(name)}] = String(await page.evaluate(() => localStorage.getItem(${quote(rule.storageKey ?? '')})));`;
  }

  void step;
  return `// Could not export the capture of "${name}".`;
}

/** Builds the Playwright locator chain, including any iframe hops. */
function locatorExpression(target: Target): string {
  let root = 'page';

  for (const hop of target.frame) {
    const selector =
      hop.kind === 'name'
        ? `iframe[name="${hop.value}"]`
        : hop.kind === 'url'
          ? `iframe[src*="${hop.value}"]`
          : hop.value;

    root = `${root}.frameLocator(${quote(selector)})`;
  }

  const candidate = target.candidates[target.primaryIndex] ?? target.candidates[0];

  if (!candidate) {
    return `${root}.locator('body')`;
  }

  const expression = `${root}.${candidateExpression(candidate)}`;

  return candidate.nth === undefined ? expression : `${expression}.nth(${candidate.nth})`;
}

function candidateExpression(candidate: SelectorCandidate): string {
  const exact = candidate.exact ? ', { exact: true }' : '';

  switch (candidate.engine) {
    case 'testid':
      return `getByTestId(${quote(candidate.value)})`;
    case 'role':
      return candidate.name === undefined
        ? `getByRole(${quote(candidate.value)})`
        : `getByRole(${quote(candidate.value)}, { name: ${quote(candidate.name)}${candidate.exact ? ', exact: true' : ''} })`;
    case 'label':
      return `getByLabel(${quote(candidate.value)}${exact})`;
    case 'placeholder':
      return `getByPlaceholder(${quote(candidate.value)}${exact})`;
    case 'altText':
      return `getByAltText(${quote(candidate.value)}${exact})`;
    case 'title':
      return `getByTitle(${quote(candidate.value)}${exact})`;
    case 'text':
      return `getByText(${quote(candidate.value)}${exact})`;
    case 'css':
      return `locator(${quote(candidate.value)})`;
    case 'xpath':
      return `locator(${quote(`xpath=${candidate.value}`)})`;
  }
}

/** `{{name}}` becomes a template-literal interpolation of the vars object. */
function valueExpression(template: string): string {
  if (!template.includes('{{')) {
    return quote(template);
  }

  const body = template
    .replace(/[`\\$]/g, '\\$&')
    .replace(/\\\$\{/g, '${')
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
      const name = String(expression).split('|')[0]?.trim() ?? '';

      if (name.startsWith('$')) {
        return `\${${generatorExpression(name)}}`;
      }

      return `\${vars[${quote(name)}] ?? ''}`;
    });

  return `\`${body}\``;
}

function generatorExpression(name: string): string {
  switch (name.replace(/\(.*\)$/, '')) {
    case '$uuid':
      return 'crypto.randomUUID()';
    case '$timestamp':
      return 'Date.now()';
    case '$date':
      return 'new Date().toISOString().slice(0, 10)';
    case '$randomEmail':
      return "`test+${Date.now()}@example.com`";
    default:
      return `'' /* ${name} */`;
  }
}

function urlExpression(value: string): string {
  const rendered = valueExpression(value);

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return rendered;
  }

  return rendered.startsWith('`') ? `\`\${baseUrl}${rendered.slice(1)}` : `baseUrl + ${rendered}`;
}

function globExpression(value: string): string {
  return value.startsWith('re:') ? `/${value.slice(3)}/` : quote(value);
}

function regexExpression(pattern: string): string {
  return `/${pattern.replace(/\//g, '\\/')}/`;
}

function buildVariableSeed(test: TestCase, environment: Environment | undefined): string[] {
  const entries: string[] = [];

  for (const [name, value] of Object.entries(environment?.variables ?? {})) {
    entries.push(`${quote(name)}: ${quote(value)}`);
  }

  for (const [name, envVar] of Object.entries(environment?.secretRefs ?? {})) {
    entries.push(`${quote(name)}: process.env.${envVar} ?? ''`);
  }

  for (const variable of test.variables) {
    if (variable.source !== 'runtime') {
      entries.push(`${quote(variable.name)}: ${quote(variable.defaultValue)}`);
    }
  }

  return entries;
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}
