import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserLaunch } from '../src/engine/runner.js';
import { showRipple } from '../src/engine/highlight.js';
import { createEnvironment } from '../src/model/factory.js';
import type { Environment } from '../src/model/test.js';

const environment = (overrides: Partial<Environment> = {}): Environment => ({
  ...createEnvironment({ name: 'test' }),
  ...overrides,
});

describe('resolveBrowserLaunch', () => {
  it('defaults to headless when nothing says otherwise', () => {
    expect(resolveBrowserLaunch(undefined, undefined, undefined).headless).toBe(true);
  });

  it('lets the environment decide when the run does not ask', () => {
    const headedEnvironment = environment({ headless: false });

    expect(resolveBrowserLaunch(headedEnvironment, undefined, undefined).headless).toBe(false);
    expect(resolveBrowserLaunch(environment({ headless: true }), undefined, undefined).headless).toBe(true);
  });

  it('lets an explicit choice override the environment, in both directions', () => {
    expect(resolveBrowserLaunch(environment({ headless: true }), true, undefined).headless).toBe(false);
    expect(resolveBrowserLaunch(environment({ headless: false }), false, undefined).headless).toBe(true);
  });

  it('takes slow motion from the environment unless the run overrides it', () => {
    const slow = environment({ headless: false, slowMoMs: 250 });

    expect(resolveBrowserLaunch(slow, undefined, undefined).slowMo).toBe(250);
    expect(resolveBrowserLaunch(slow, undefined, 800).slowMo).toBe(800);
  });

  it('ignores slow motion when headless, so CI is never slowed', () => {
    const slow = environment({ headless: true, slowMoMs: 500 });

    expect(resolveBrowserLaunch(slow, undefined, undefined).slowMo).toBe(0);
    expect(resolveBrowserLaunch(slow, undefined, 900).slowMo).toBe(0);
    // Explicitly asking for a headed run brings it back.
    expect(resolveBrowserLaunch(slow, true, undefined).slowMo).toBe(500);
  });

  it('only highlights when someone is watching', () => {
    expect(resolveBrowserLaunch(environment({ headless: true }), undefined, undefined).highlight).toBe(false);
    expect(resolveBrowserLaunch(environment({ headless: false }), undefined, undefined).highlight).toBe(true);
    expect(
      resolveBrowserLaunch(environment({ headless: false, highlightActions: false }), undefined, undefined)
        .highlight,
    ).toBe(false);
  });
});

describe('the click ripple', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(
      `<!doctype html><body style="margin:0">
         <button id="target" style="position:absolute;left:100px;top:80px;width:40px;height:20px">Go</button>
         <p id="log"></p>
         <script>
           document.getElementById('target')
             .addEventListener('click', () => { document.getElementById('log').textContent = 'clicked'; });
         </script>
       </body>`,
    );
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('appears centred on the element', async () => {
    const locator = page.locator('#target');
    await showRipple(page, locator);

    expect(await page.locator('.__flowcase_ripple').count()).toBe(1);
    expect(await page.locator('#__flowcase_highlight').count()).toBe(1);

    // The button spans 100–140 × 80–100, so its centre is (120, 90).
    const position = await page.locator('.__flowcase_ripple').evaluate((node) => ({
      left: (node as HTMLElement).style.left,
      top: (node as HTMLElement).style.top,
    }));

    expect(position).toEqual({ left: '120px', top: '90px' });
  }, 30_000);

  it('does not swallow the click it is marking', async () => {
    const locator = page.locator('#target');
    await showRipple(page, locator);

    // The ripple is 56px across and centred on a 40×20 button, so it covers it
    // completely. Without `pointer-events: none` this click would time out.
    await locator.click({ timeout: 5000 });

    expect(await page.locator('#log').textContent()).toBe('clicked');
  }, 30_000);

  it('cleans up after itself', async () => {
    await showRipple(page, page.locator('#target'));

    await expect.poll(() => page.locator('.__flowcase_ripple').count(), { timeout: 5000 }).toBe(0);
  }, 30_000);
});
