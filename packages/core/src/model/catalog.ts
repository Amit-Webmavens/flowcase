import type { Step, StepKind } from './step.js';
import { describeTarget } from './selector.js';
import { describeMatcher } from '../util/match.js';

export type StepGroup =
  | 'Navigation'
  | 'Interaction'
  | 'Waiting'
  | 'Assertion'
  | 'Data'
  | 'Composition'
  | 'Utility';

/** How the no-code editor should render an operand field. */
export type FieldKind =
  | 'text'
  | 'multiline'
  | 'url'
  | 'number'
  | 'key'
  | 'duration'
  | 'loadState'
  | 'variableName'
  | 'snippetName'
  | 'sessionName';

export interface FieldDefinition {
  label: string;
  kind: FieldKind;
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface StepDefinition {
  kind: StepKind;
  label: string;
  group: StepGroup;
  description: string;
  /** Whether the step acts on a page element and therefore needs a selector. */
  needsTarget: boolean;
  value?: FieldDefinition;
  value2?: FieldDefinition;
  /** Assertion steps can be made soft, and are reported separately. */
  isAssertion: boolean;
  /** Steps that cannot sensibly repeat (session/mock management). */
  supportsRepeat: boolean;
  /** Whether the `matcher` field applies. */
  supportsMatcher: boolean;
}

function def(input: Partial<StepDefinition> & Pick<StepDefinition, 'kind' | 'label' | 'group' | 'description'>): StepDefinition {
  return {
    needsTarget: false,
    isAssertion: false,
    supportsRepeat: true,
    supportsMatcher: false,
    ...input,
  };
}

const text = (label: string, required = true, placeholder?: string): FieldDefinition => ({
  label,
  kind: 'text',
  required,
  ...(placeholder === undefined ? {} : { placeholder }),
});

/**
 * The single source of truth for what each step kind needs. The React editor
 * builds its forms from this table and the engine validates against it, so a new
 * step kind only has to be described once.
 */
export const STEP_CATALOG: Record<StepKind, StepDefinition> = {
  // ── Navigation ────────────────────────────────────────────────────────────
  goto: def({
    kind: 'goto',
    label: 'Go to URL',
    group: 'Navigation',
    description: 'Navigate to a URL. Relative paths resolve against the environment base URL.',
    value: { label: 'URL', kind: 'url', required: true, placeholder: '/orders/create' },
  }),
  reload: def({ kind: 'reload', label: 'Reload page', group: 'Navigation', description: 'Reload the current page.' }),
  goBack: def({ kind: 'goBack', label: 'Go back', group: 'Navigation', description: 'Navigate back in history.' }),
  goForward: def({ kind: 'goForward', label: 'Go forward', group: 'Navigation', description: 'Navigate forward in history.' }),
  setViewport: def({
    kind: 'setViewport',
    label: 'Set viewport',
    group: 'Navigation',
    description: 'Resize the browser viewport.',
    value: { label: 'Width', kind: 'number', required: true, placeholder: '1280' },
    value2: { label: 'Height', kind: 'number', required: true, placeholder: '720' },
  }),

  // ── Interaction ───────────────────────────────────────────────────────────
  click: def({ kind: 'click', label: 'Click', group: 'Interaction', description: 'Click an element.', needsTarget: true }),
  dblclick: def({ kind: 'dblclick', label: 'Double click', group: 'Interaction', description: 'Double click an element.', needsTarget: true }),
  rightClick: def({ kind: 'rightClick', label: 'Right click', group: 'Interaction', description: 'Open the context menu on an element.', needsTarget: true }),
  fill: def({
    kind: 'fill',
    label: 'Fill field',
    group: 'Interaction',
    description: 'Set an input value in one shot. Fastest and most reliable for forms.',
    needsTarget: true,
    value: { label: 'Value', kind: 'text', required: false, placeholder: '{{customerName}}', help: 'Supports {{variables}}.' },
  }),
  type: def({
    kind: 'type',
    label: 'Type text',
    group: 'Interaction',
    description: 'Type character by character, firing each keystroke. Use when a field reacts to typing.',
    needsTarget: true,
    value: { label: 'Text', kind: 'text', required: false, placeholder: '{{searchTerm}}' },
    value2: { label: 'Delay (ms/char)', kind: 'number', required: false, placeholder: '50' },
  }),
  press: def({
    kind: 'press',
    label: 'Press key',
    group: 'Interaction',
    description: 'Press a keyboard key, optionally scoped to an element.',
    value: { label: 'Key', kind: 'key', required: true, placeholder: 'Enter' },
  }),
  select: def({
    kind: 'select',
    label: 'Select option',
    group: 'Interaction',
    description: 'Choose an option in a <select> by value or visible label.',
    needsTarget: true,
    value: { label: 'Option', kind: 'text', required: true, placeholder: 'Pending' },
  }),
  check: def({ kind: 'check', label: 'Check', group: 'Interaction', description: 'Tick a checkbox or radio.', needsTarget: true }),
  uncheck: def({ kind: 'uncheck', label: 'Uncheck', group: 'Interaction', description: 'Untick a checkbox.', needsTarget: true }),
  hover: def({ kind: 'hover', label: 'Hover', group: 'Interaction', description: 'Move the pointer over an element.', needsTarget: true }),
  focus: def({ kind: 'focus', label: 'Focus', group: 'Interaction', description: 'Give an element keyboard focus.', needsTarget: true }),
  clear: def({ kind: 'clear', label: 'Clear field', group: 'Interaction', description: 'Empty an input.', needsTarget: true }),
  upload: def({
    kind: 'upload',
    label: 'Upload files',
    group: 'Interaction',
    description: 'Attach one or more files to a file input.',
    needsTarget: true,
  }),
  dragAndDrop: def({
    kind: 'dragAndDrop',
    label: 'Drag and drop',
    group: 'Interaction',
    description: 'Drag the target element onto another element.',
    needsTarget: true,
    value: { label: 'Drop target', kind: 'text', required: true, placeholder: 'CSS selector of the drop zone' },
  }),
  scrollTo: def({ kind: 'scrollTo', label: 'Scroll to', group: 'Interaction', description: 'Scroll an element into view.', needsTarget: true }),

  // ── Waiting ───────────────────────────────────────────────────────────────
  waitForSelector: def({ kind: 'waitForSelector', label: 'Wait for element', group: 'Waiting', description: 'Wait until an element is visible.', needsTarget: true }),
  waitForHidden: def({ kind: 'waitForHidden', label: 'Wait for element to disappear', group: 'Waiting', description: 'Wait until an element is hidden or detached — useful for spinners.', needsTarget: true }),
  waitForUrl: def({
    kind: 'waitForUrl',
    label: 'Wait for URL',
    group: 'Waiting',
    description: 'Wait until the page URL matches a pattern.',
    value: { label: 'URL pattern', kind: 'text', required: true, placeholder: '**/orders/*' },
    supportsMatcher: true,
  }),
  waitForText: def({
    kind: 'waitForText',
    label: 'Wait for text',
    group: 'Waiting',
    description: 'Wait until text appears anywhere on the page.',
    value: text('Text'),
  }),
  waitForTimeout: def({
    kind: 'waitForTimeout',
    label: 'Wait (fixed delay)',
    group: 'Waiting',
    description: 'Pause for a fixed time. Prefer a condition-based wait where possible.',
    value: { label: 'Duration (ms)', kind: 'duration', required: true, placeholder: '1000' },
  }),
  waitForResponse: def({
    kind: 'waitForResponse',
    label: 'Wait for network response',
    group: 'Waiting',
    description: 'Wait until a request matching a URL pattern completes.',
    value: { label: 'URL pattern', kind: 'text', required: true, placeholder: '**/api/orders' },
  }),
  waitForLoadState: def({
    kind: 'waitForLoadState',
    label: 'Wait for load state',
    group: 'Waiting',
    description: 'Wait for the document to reach a load state.',
    value: { label: 'State', kind: 'loadState', required: true, placeholder: 'networkidle' },
  }),

  // ── Assertions ────────────────────────────────────────────────────────────
  assertVisible: def({ kind: 'assertVisible', label: 'Assert visible', group: 'Assertion', description: 'The element must be visible.', needsTarget: true, isAssertion: true }),
  assertHidden: def({ kind: 'assertHidden', label: 'Assert hidden', group: 'Assertion', description: 'The element must be hidden or absent.', needsTarget: true, isAssertion: true }),
  assertText: def({
    kind: 'assertText',
    label: 'Assert text',
    group: 'Assertion',
    description: "Check an element's text content.",
    needsTarget: true,
    isAssertion: true,
    supportsMatcher: true,
    value: text('Expected text'),
  }),
  assertValue: def({
    kind: 'assertValue',
    label: 'Assert field value',
    group: 'Assertion',
    description: "Check an input's current value.",
    needsTarget: true,
    isAssertion: true,
    supportsMatcher: true,
    value: text('Expected value'),
  }),
  assertUrl: def({
    kind: 'assertUrl',
    label: 'Assert URL',
    group: 'Assertion',
    description: 'Check the current page URL.',
    isAssertion: true,
    supportsMatcher: true,
    value: text('Expected URL'),
  }),
  assertTitle: def({
    kind: 'assertTitle',
    label: 'Assert page title',
    group: 'Assertion',
    description: 'Check the document title.',
    isAssertion: true,
    supportsMatcher: true,
    value: text('Expected title'),
  }),
  assertCount: def({
    kind: 'assertCount',
    label: 'Assert element count',
    group: 'Assertion',
    description: 'Check how many elements match the selector.',
    needsTarget: true,
    isAssertion: true,
    value: { label: 'Expected count', kind: 'number', required: true, placeholder: '3' },
  }),
  assertAttribute: def({
    kind: 'assertAttribute',
    label: 'Assert attribute',
    group: 'Assertion',
    description: "Check an element's attribute value.",
    needsTarget: true,
    isAssertion: true,
    supportsMatcher: true,
    value: text('Attribute name', true, 'href'),
    value2: text('Expected value', false),
  }),
  assertChecked: def({ kind: 'assertChecked', label: 'Assert checked', group: 'Assertion', description: 'The checkbox or radio must be checked.', needsTarget: true, isAssertion: true }),
  assertEnabled: def({ kind: 'assertEnabled', label: 'Assert enabled', group: 'Assertion', description: 'The control must be enabled.', needsTarget: true, isAssertion: true }),
  assertDisabled: def({ kind: 'assertDisabled', label: 'Assert disabled', group: 'Assertion', description: 'The control must be disabled.', needsTarget: true, isAssertion: true }),

  // ── Data ──────────────────────────────────────────────────────────────────
  extract: def({
    kind: 'extract',
    label: 'Capture value',
    group: 'Data',
    description: 'Read a value from the page, URL or an API response and store it as a variable for later steps.',
  }),
  setVariable: def({
    kind: 'setVariable',
    label: 'Set variable',
    group: 'Data',
    description: 'Assign a literal or computed value to a variable.',
    value: { label: 'Variable name', kind: 'variableName', required: true, placeholder: 'orderId' },
    value2: { label: 'Value', kind: 'text', required: false, placeholder: '{{_index}}' },
  }),

  // ── Composition ───────────────────────────────────────────────────────────
  group: def({
    kind: 'group',
    label: 'Group',
    group: 'Composition',
    description: 'A block of steps that can be repeated, disabled or annotated together.',
    value: text('Group name', false, 'Add three line items'),
  }),
  snippet: def({
    kind: 'snippet',
    label: 'Use snippet',
    group: 'Composition',
    description: 'Insert a reusable fragment shared across tests.',
    value: { label: 'Snippet', kind: 'snippetName', required: true },
  }),

  // ── Utility ───────────────────────────────────────────────────────────────
  screenshot: def({
    kind: 'screenshot',
    label: 'Take screenshot',
    group: 'Utility',
    description: 'Capture a screenshot and attach it to the run report.',
    value: text('Label', false, 'after-checkout'),
  }),
  visualCheck: def({
    kind: 'visualCheck',
    label: 'Visual check',
    group: 'Utility',
    description: 'Compare a screenshot against an approved baseline image.',
    isAssertion: true,
    value: text('Baseline name', false, 'order-summary'),
  }),
  mockRoute: def({
    kind: 'mockRoute',
    label: 'Mock network route',
    group: 'Utility',
    description: 'Intercept matching requests and return a canned response.',
    supportsRepeat: false,
  }),
  unmockRoute: def({
    kind: 'unmockRoute',
    label: 'Remove network mock',
    group: 'Utility',
    description: 'Stop intercepting a previously mocked route.',
    supportsRepeat: false,
    value: text('Mock id or URL pattern'),
  }),
  saveSession: def({
    kind: 'saveSession',
    label: 'Save session',
    group: 'Utility',
    description: 'Persist cookies and storage so other tests can skip logging in.',
    supportsRepeat: false,
    value: { label: 'Session name', kind: 'sessionName', required: true, placeholder: 'admin' },
  }),
  loadSession: def({
    kind: 'loadSession',
    label: 'Load session',
    group: 'Utility',
    description: 'Restore a previously saved session.',
    supportsRepeat: false,
    value: { label: 'Session name', kind: 'sessionName', required: true, placeholder: 'admin' },
  }),
  comment: def({
    kind: 'comment',
    label: 'Comment',
    group: 'Utility',
    description: 'A note in the step list. Does nothing when the test runs.',
    supportsRepeat: false,
    value: { label: 'Comment', kind: 'multiline', required: false },
  }),
};

export const STEP_GROUPS: StepGroup[] = [
  'Navigation',
  'Interaction',
  'Waiting',
  'Assertion',
  'Data',
  'Composition',
  'Utility',
];

export function stepDefinition(kind: StepKind): StepDefinition {
  return STEP_CATALOG[kind];
}

/**
 * Human-readable one-liner for a step, used in the step list, run report and
 * exported code comments. Falls back to the catalog label when the step has no
 * operands yet.
 */
export function summarizeStep(step: Step): string {
  if (step.label.trim().length > 0) {
    return step.label;
  }

  const definition = STEP_CATALOG[step.kind];
  const target = step.target ? describeTarget(step.target) : '';
  const value = step.value ?? '';

  switch (step.kind) {
    case 'goto':
      return `Go to ${value}`;
    case 'click':
    case 'dblclick':
    case 'rightClick':
    case 'hover':
    case 'focus':
    case 'check':
    case 'uncheck':
    case 'clear':
    case 'scrollTo':
      return `${definition.label} ${target}`;
    case 'fill':
    case 'type':
      return `${definition.label} ${target} with "${value}"`;
    case 'select':
      return `Select "${value}" in ${target}`;
    case 'press':
      return target ? `Press ${value} in ${target}` : `Press ${value}`;
    case 'assertText':
      return `Expect ${target} to ${describeMatcher(step.matcher)} "${value}"`;
    case 'assertUrl':
      return `Expect URL to ${describeMatcher(step.matcher)} "${value}"`;
    case 'assertTitle':
      return `Expect title to ${describeMatcher(step.matcher)} "${value}"`;
    case 'assertCount':
      return `Expect ${value} × ${target}`;
    case 'assertVisible':
      return `Expect ${target} to be visible`;
    case 'assertHidden':
      return `Expect ${target} to be hidden`;
    case 'waitForTimeout':
      return `Wait ${value}ms`;
    case 'waitForUrl':
      return `Wait for URL ${value}`;
    case 'extract': {
      const names = step.extract.map((rule) => rule.name).join(', ');
      return names.length > 0 ? `Capture ${names}` : 'Capture value';
    }
    case 'setVariable':
      return `Set ${value} = ${step.value2 ?? ''}`;
    case 'group':
      return value.length > 0 ? value : 'Group';
    case 'comment':
      return value;
    default:
      return target.length > 0 ? `${definition.label} ${target}` : definition.label;
  }
}
