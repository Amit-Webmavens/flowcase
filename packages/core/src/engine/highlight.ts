import type { Locator, Page } from 'playwright';

/** Long enough to notice, short enough not to trail behind a fast run. */
const RIPPLE_MS = 600;

/**
 * Marks where the runner is about to act, so a headed run can be followed.
 *
 * Purely decorative and best-effort: the ripple never blocks input, and any
 * failure here is swallowed rather than failing a step over an animation.
 */
export async function showRipple(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox().catch(() => null);

  if (!box) {
    return;
  }

  await page
    .evaluate(paintRipple, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      ms: RIPPLE_MS,
    })
    .catch(() => undefined);
}

/** Shared with the recorder's injected copy, which cannot import this module. */
export const RIPPLE_STYLE_ID = '__flowcase_highlight';
export const RIPPLE_CLASS = '__flowcase_ripple';

/**
 * Runs inside the page. Coordinates are viewport-relative, which is what
 * `position: fixed` expects, so the ripple lands correctly on a scrolled page.
 */
function paintRipple(point: { x: number; y: number; ms: number }): void {
  const styleId = '__flowcase_highlight';
  const head = document.head ?? document.documentElement;

  if (head && !document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes __flowcase_ripple_in {
        from { transform: translate(-50%, -50%) scale(0.25); opacity: 0.95; }
        to   { transform: translate(-50%, -50%) scale(1);    opacity: 0; }
      }
      .__flowcase_ripple {
        position: fixed;
        width: 56px;
        height: 56px;
        margin: 0;
        padding: 0;
        border-radius: 9999px;
        border: 3px solid rgba(56, 132, 255, 0.95);
        background: rgba(56, 132, 255, 0.22);
        pointer-events: none;
        z-index: 2147483647;
        animation: __flowcase_ripple_in var(--flowcase-ripple-ms, 600ms) ease-out forwards;
      }`;
    head.append(style);
  }

  if (!document.body) {
    return;
  }

  const ripple = document.createElement('div');
  ripple.className = '__flowcase_ripple';
  ripple.style.left = `${point.x}px`;
  ripple.style.top = `${point.y}px`;
  ripple.style.setProperty('--flowcase-ripple-ms', `${point.ms}ms`);
  document.body.append(ripple);

  window.setTimeout(() => ripple.remove(), point.ms);
}
