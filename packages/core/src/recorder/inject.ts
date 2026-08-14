import type { ElementSnapshot, SelectorCandidate } from '../model/selector.js';
import type { InjectConfig, RecordedEvent, RecordedTarget, RecorderMode } from './protocol.js';

/**
 * Runs inside every frame of the recorded page.
 *
 * Playwright serialises this function, so it must stay self-contained: it may
 * only use its `config` argument and browser globals. Everything is delegated
 * from `document` in the capture phase, which is what makes it work on dynamic
 * sites — elements mounted later by a framework need no re-binding, and the
 * script is re-installed automatically on every navigation and in every iframe.
 */
export function installRecorder(config: InjectConfig): void {
  if (window.__flowcaseInstalled) {
    return;
  }

  window.__flowcaseInstalled = true;

  const TOOLBAR_ID = '__flowcase_toolbar';
  let mode: RecorderMode = 'record';
  /** When armed, the next click is captured as an assertion instead of an action. */
  let armedAssertion: 'assertText' | 'assertVisible' | undefined;

  const queue: RecordedEvent[] = [];

  const flush = (): void => {
    const send = window.__flowcaseRecord;

    if (!send) {
      return;
    }

    while (queue.length > 0) {
      const event = queue.shift();

      if (event) {
        void send(event).catch(() => undefined);
      }
    }
  };

  const emit = (event: RecordedEvent): void => {
    queue.push(event);
    flush();
  };

  // The binding may not be installed the instant this script runs; retry briefly.
  const flushTimer = window.setInterval(flush, 200);
  window.addEventListener('pagehide', () => window.clearInterval(flushTimer));

  window.__flowcaseSetMode = (next: RecorderMode): void => {
    mode = next;
    armedAssertion = undefined;
    renderToolbar();
  };

  // ── Element description ──────────────────────────────────────────────────

  const looksGenerated = (value: string): boolean =>
    value.length === 0 ||
    /^:r[0-9a-z]+:?$/i.test(value) ||
    /^(mui|ember|radix|headlessui|reach|chakra|mantine)[-_]/i.test(value) ||
    /[0-9a-f]{8,}/i.test(value) ||
    /\d{4,}/.test(value) ||
    /^css-[0-9a-z]+$/i.test(value) ||
    /^sc-[0-9a-z]+$/i.test(value);

  const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();

  const implicitRole = (element: Element): string | undefined => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') ?? '').toLowerCase();

    if (tag === 'a') return element.hasAttribute('href') ? 'link' : undefined;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'table') return 'table';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'nav') return 'navigation';
    if (tag === 'form') return 'form';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return undefined;
      return 'textbox';
    }

    return undefined;
  };

  const roleOf = (element: Element): string | undefined =>
    element.getAttribute('role') ?? implicitRole(element);

  const labelFor = (element: Element): string | undefined => {
    const id = element.getAttribute('id');

    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);

      if (label) {
        return normalize(label.textContent);
      }
    }

    const wrapping = element.closest('label');

    return wrapping ? normalize(wrapping.textContent) : undefined;
  };

  const accessibleName = (element: Element): string | undefined => {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return normalize(ariaLabel);

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (normalize(text)) return normalize(text);
    }

    const label = labelFor(element);
    if (label) return label;

    const alt = element.getAttribute('alt');
    if (alt) return normalize(alt);

    const title = element.getAttribute('title');
    if (title) return normalize(title);

    const tag = element.tagName.toLowerCase();
    const value = element.getAttribute('value');
    if (value && tag === 'input') return normalize(value);

    // Form controls take their name from a label, never from their contents:
    // a <select>'s text is the concatenation of its options, which is meaningless
    // as an identifier and changes whenever the option list does.
    if (tag === 'select' || tag === 'input' || tag === 'textarea') {
      return undefined;
    }

    return normalize(element.textContent).slice(0, 120) || undefined;
  };

  const cssPath = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;

    while (current && current.nodeType === 1 && parts.length < 8) {
      const tag = current.tagName.toLowerCase();

      if (tag === 'html' || tag === 'body') {
        break;
      }

      const id = current.getAttribute('id');

      if (id && !looksGenerated(id)) {
        parts.unshift(`#${CSS.escape(id)}`);
        break;
      }

      const stableClass = Array.from(current.classList).find((name) => !looksGenerated(name));
      const parent: Element | null = current.parentElement;

      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current?.tagName);

        if (sameTag.length > 1) {
          const index = sameTag.indexOf(current) + 1;
          parts.unshift(`${tag}${stableClass ? `.${CSS.escape(stableClass)}` : ''}:nth-of-type(${index})`);
        } else {
          parts.unshift(`${tag}${stableClass ? `.${CSS.escape(stableClass)}` : ''}`);
        }
      } else {
        parts.unshift(tag);
      }

      current = parent;
    }

    return parts.join(' > ');
  };

  const xpathOf = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;

    while (current && current.nodeType === 1) {
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;

      if (!parent) {
        parts.unshift(`/${tag}`);
        break;
      }

      const sameTag = Array.from(parent.children).filter((child) => child.tagName === current?.tagName);
      const index = sameTag.indexOf(current) + 1;
      parts.unshift(`/${tag}[${index}]`);
      current = parent;
    }

    return parts.join('');
  };

  const countCss = (selector: string): { count: number; index: number } => {
    try {
      const matches = Array.from(document.querySelectorAll(selector));
      return { count: matches.length, index: matches.indexOf(lastTarget as Element) };
    } catch {
      return { count: 0, index: -1 };
    }
  };

  /**
   * Approximate uniqueness check for the accessibility-based engines. Playwright
   * resolves these differently, so a non-unique result lowers the candidate's
   * score rather than pinning an index that might not line up.
   */
  const countByPredicate = (predicate: (element: Element) => boolean): number => {
    const all = document.querySelectorAll('*');
    let count = 0;

    for (let index = 0; index < all.length && index < 5000; index += 1) {
      const element = all[index];

      if (element && predicate(element)) {
        count += 1;
      }
    }

    return count;
  };

  let lastTarget: Element | undefined;

  const buildCandidates = (element: Element): SelectorCandidate[] => {
    lastTarget = element;

    const candidates: SelectorCandidate[] = [];
    const base = config.baseScores;
    const push = (candidate: SelectorCandidate): void => {
      if (candidate.value.length > 0) {
        candidates.push(candidate);
      }
    };

    const testId = element.getAttribute(config.testIdAttribute);

    if (testId) {
      push({ engine: 'testid', value: testId, score: base.testid ?? 100, source: 'recorded' });
    }

    const role = roleOf(element);
    const name = accessibleName(element);

    if (role && name && name.length <= 120) {
      const matches = countByPredicate(
        (candidate) => roleOf(candidate) === role && accessibleName(candidate) === name,
      );

      push({
        engine: 'role',
        value: role,
        name,
        exact: true,
        score: (base.role ?? 85) - (matches === 1 ? 0 : 25),
        source: 'recorded',
      });
    }

    const label = labelFor(element);

    if (label) {
      const matches = countByPredicate((candidate) => labelFor(candidate) === label);
      push({
        engine: 'label',
        value: label,
        exact: true,
        score: (base.label ?? 80) - (matches === 1 ? 0 : 25),
        source: 'recorded',
      });
    }

    const placeholder = element.getAttribute('placeholder');

    if (placeholder) {
      const matches = document.querySelectorAll(
        `[placeholder="${CSS.escape(placeholder)}"]`,
      ).length;
      push({
        engine: 'placeholder',
        value: placeholder,
        exact: true,
        score: (base.placeholder ?? 70) - (matches === 1 ? 0 : 25),
        source: 'recorded',
      });
    }

    const alt = element.getAttribute('alt');

    if (alt) {
      push({ engine: 'altText', value: alt, exact: true, score: base.altText ?? 65, source: 'recorded' });
    }

    const title = element.getAttribute('title');

    if (title) {
      push({ engine: 'title', value: title, exact: true, score: base.title ?? 60, source: 'recorded' });
    }

    const text = normalize(element.textContent);

    if (text.length > 0 && text.length <= 80 && element.children.length === 0) {
      const matches = countByPredicate(
        (candidate) => candidate.children.length === 0 && normalize(candidate.textContent) === text,
      );
      push({
        engine: 'text',
        value: text,
        exact: true,
        score: (base.text ?? 55) - (matches === 1 ? 0 : 25),
        source: 'recorded',
      });
    }

    const css = cssPath(element);

    if (css) {
      const { count, index } = countCss(css);
      push({
        engine: 'css',
        value: css,
        score: (base.css ?? 40) - (count === 1 ? 0 : 10),
        source: 'recorded',
        ...(count > 1 && index >= 0 ? { nth: index } : {}),
      });
    }

    push({ engine: 'xpath', value: xpathOf(element), score: base.xpath ?? 20, source: 'recorded' });

    return candidates.sort((a, b) => b.score - a.score);
  };

  const snapshotOf = (element: Element): ElementSnapshot => {
    const attributes: Record<string, string> = {};

    for (const attribute of Array.from(element.attributes)) {
      attributes[attribute.name] = attribute.value;
    }

    const parent = element.parentElement;
    const siblings = parent
      ? Array.from(parent.children).filter((child) => child.tagName === element.tagName)
      : [];
    const rect = element.getBoundingClientRect();

    return {
      tagName: element.tagName.toLowerCase(),
      role: roleOf(element),
      accessibleName: accessibleName(element),
      text: normalize(element.textContent).slice(0, 200),
      elementId: element.id || undefined,
      classes: Array.from(element.classList),
      attributes,
      inputType: element.getAttribute('type') ?? undefined,
      siblingIndex: siblings.indexOf(element),
      boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };

  const describe = (element: Element): string => {
    const role = roleOf(element) ?? element.tagName.toLowerCase();
    const name = accessibleName(element);

    return name ? `${role} "${name.slice(0, 60)}"` : role;
  };

  const targetOf = (element: Element, insideShadow: boolean): RecordedTarget => ({
    candidates: buildCandidates(element),
    snapshot: snapshotOf(element),
    description: describe(element),
    inShadowDom: insideShadow,
  });

  // ── Pending text input ───────────────────────────────────────────────────
  // Typing fires many `input` events; only the final value is interesting, so it
  // is buffered and flushed when focus moves, the form is submitted, or the page
  // navigates. That turns a burst of keystrokes into one "Fill field" step.

  let pending: { element: Element; value: string; shadow: boolean } | undefined;

  const flushPending = (): void => {
    if (!pending) {
      return;
    }

    const captured = pending;
    pending = undefined;

    emit({
      type: 'fill',
      target: targetOf(captured.element, captured.shadow),
      value: captured.value,
      at: Date.now(),
    });
  };

  // ── Event capture ────────────────────────────────────────────────────────

  const realTarget = (event: Event): { element: Element | undefined; shadow: boolean } => {
    const path = event.composedPath();
    const first = path[0];

    if (first instanceof Element) {
      return { element: first, shadow: path.length > 0 && first !== event.target };
    }

    return { element: event.target instanceof Element ? event.target : undefined, shadow: false };
  };

  const isToolbar = (element: Element | undefined): boolean =>
    Boolean(element?.closest(`#${TOOLBAR_ID}`));

  const recording = (): boolean => mode !== 'paused';

  document.addEventListener(
    'click',
    (event) => {
      const { element, shadow } = realTarget(event);

      if (!element || isToolbar(element) || !recording()) {
        return;
      }

      if (armedAssertion) {
        event.preventDefault();
        event.stopPropagation();

        const kind = armedAssertion;
        armedAssertion = undefined;
        mode = 'record';
        renderToolbar();

        emit({
          type: kind,
          target: targetOf(element, shadow),
          value: kind === 'assertText' ? normalize(element.textContent).slice(0, 200) : '',
          at: Date.now(),
        });
        return;
      }

      if (pending && pending.element !== element) {
        flushPending();
      }

      // Checkboxes and radios are reported by the change handler as check/uncheck.
      const input = element as HTMLInputElement;
      const type = (input.getAttribute?.('type') ?? '').toLowerCase();

      if (element.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
        return;
      }

      emit({ type: 'click', target: targetOf(element, shadow), at: Date.now() });
    },
    true,
  );

  document.addEventListener(
    'dblclick',
    (event) => {
      const { element, shadow } = realTarget(event);

      if (!element || isToolbar(element) || !recording()) {
        return;
      }

      emit({ type: 'dblclick', target: targetOf(element, shadow), at: Date.now() });
    },
    true,
  );

  document.addEventListener(
    'input',
    (event) => {
      const { element, shadow } = realTarget(event);

      if (!element || isToolbar(element) || !recording()) {
        return;
      }

      const tag = element.tagName.toLowerCase();

      if (tag !== 'input' && tag !== 'textarea' && !element.hasAttribute('contenteditable')) {
        return;
      }

      const type = (element.getAttribute('type') ?? '').toLowerCase();

      if (type === 'checkbox' || type === 'radio') {
        return;
      }

      if (pending && pending.element !== element) {
        flushPending();
      }

      const value =
        tag === 'input' || tag === 'textarea'
          ? (element as HTMLInputElement).value
          : normalize(element.textContent);

      pending = { element, value, shadow };
    },
    true,
  );

  document.addEventListener(
    'change',
    (event) => {
      const { element, shadow } = realTarget(event);

      if (!element || isToolbar(element) || !recording()) {
        return;
      }

      const tag = element.tagName.toLowerCase();

      if (tag === 'select') {
        const select = element as HTMLSelectElement;
        const option = select.selectedOptions[0];

        flushPending();
        emit({
          type: 'select',
          target: targetOf(element, shadow),
          value: option ? option.value || normalize(option.textContent) : select.value,
          at: Date.now(),
        });
        return;
      }

      const type = (element.getAttribute('type') ?? '').toLowerCase();

      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        emit({
          type: (element as HTMLInputElement).checked ? 'check' : 'uncheck',
          target: targetOf(element, shadow),
          at: Date.now(),
        });
        return;
      }

      if (pending?.element === element) {
        flushPending();
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      const { element, shadow } = realTarget(event);

      if (!element || isToolbar(element) || !recording()) {
        return;
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        flushPending();
      }

      // Tab is deliberately not recorded: it only moves focus, and the resulting
      // step list reads better without a keypress between every field.
      const interesting = ['Enter', 'Escape', 'ArrowDown', 'ArrowUp'];

      if (!interesting.includes(event.key)) {
        return;
      }

      emit({ type: 'press', target: targetOf(element, shadow), key: event.key, at: Date.now() });
    },
    true,
  );

  window.addEventListener('beforeunload', flushPending);

  // SPA route changes: patch history so client-side navigation is still recorded.
  const reportNavigation = (): void => {
    flushPending();
    emit({ type: 'navigate', url: location.href, at: Date.now() });
  };

  const originalPushState = history.pushState.bind(history);
  history.pushState = ((...args: Parameters<History['pushState']>) => {
    originalPushState(...args);
    window.setTimeout(reportNavigation, 0);
  }) as History['pushState'];

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = ((...args: Parameters<History['replaceState']>) => {
    originalReplaceState(...args);
    window.setTimeout(reportNavigation, 0);
  }) as History['replaceState'];

  window.addEventListener('popstate', reportNavigation);

  // ── Toolbar ──────────────────────────────────────────────────────────────

  function renderToolbar(): void {
    if (!config.toolbar || window !== window.top) {
      return;
    }

    const existing = document.getElementById(TOOLBAR_ID);

    if (!existing) {
      return;
    }

    const status = existing.querySelector('[data-flowcase-status]');

    if (status) {
      status.textContent =
        mode === 'paused'
          ? '❚❚ Paused'
          : armedAssertion
            ? '⊕ Click the element to check'
            : '● Recording';
    }

    const pause = existing.querySelector('[data-flowcase-pause]');

    if (pause) {
      pause.textContent = mode === 'paused' ? 'Resume' : 'Pause';
    }
  }

  function buildToolbar(): void {
    if (!config.toolbar || window !== window.top || document.getElementById(TOOLBAR_ID)) {
      return;
    }

    const bar = document.createElement('div');
    bar.id = TOOLBAR_ID;
    bar.setAttribute('data-flowcase', 'toolbar');
    bar.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'bottom:16px',
      'left:50%',
      'transform:translateX(-50%)',
      'display:flex',
      'gap:8px',
      'align-items:center',
      'padding:8px 12px',
      'border-radius:999px',
      'background:#111827',
      'color:#f9fafb',
      'font:500 13px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
    ].join(';');

    const status = document.createElement('span');
    status.setAttribute('data-flowcase-status', '');
    status.style.cssText = 'color:#f87171;margin-right:4px;white-space:nowrap';
    status.textContent = '● Recording';
    bar.appendChild(status);

    const makeButton = (label: string, attribute: string, onClick: () => void): HTMLButtonElement => {
      const button = document.createElement('button');
      button.textContent = label;
      button.setAttribute(attribute, '');
      button.type = 'button';
      button.style.cssText = [
        'all:unset',
        'cursor:pointer',
        'padding:4px 10px',
        'border-radius:999px',
        'background:#374151',
        'color:#f9fafb',
        'font:500 12px/1.2 ui-sans-serif,system-ui,sans-serif',
        'white-space:nowrap',
      ].join(';');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      bar.appendChild(button);
      return button;
    };

    makeButton('Pause', 'data-flowcase-pause', () => {
      mode = mode === 'paused' ? 'record' : 'paused';
      armedAssertion = undefined;
      emit({ type: 'mode', mode, at: Date.now() });
      renderToolbar();
    });

    makeButton('Check text', 'data-flowcase-assert-text', () => {
      armedAssertion = 'assertText';
      mode = 'assert';
      renderToolbar();
    });

    makeButton('Check visible', 'data-flowcase-assert-visible', () => {
      armedAssertion = 'assertVisible';
      mode = 'assert';
      renderToolbar();
    });

    makeButton('Finish', 'data-flowcase-finish', () => {
      flushPending();
      emit({ type: 'finish', at: Date.now() });
    });

    document.documentElement.appendChild(bar);
    renderToolbar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildToolbar);
  } else {
    buildToolbar();
  }

  // Frameworks that replace the whole body can drop the toolbar; re-add it.
  const observer = new MutationObserver(() => {
    if (config.toolbar && window === window.top && !document.getElementById(TOOLBAR_ID)) {
      buildToolbar();
    }
  });

  const startObserving = (): void => {
    if (document.body) {
      observer.observe(document.documentElement, { childList: true, subtree: false });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }
}
