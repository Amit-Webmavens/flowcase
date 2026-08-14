import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStep, createTest } from '../src/model/factory.js';
import type { Target } from '../src/model/selector.js';
import type { Environment, TestCase } from '../src/model/test.js';
import { PrerequisiteFailedError } from '../src/recorder/prerequisites.js';
import { RecorderSession } from '../src/recorder/recorder.js';
import { ProjectStore } from '../src/storage/store.js';

/**
 * Recording behind a login is the case this covers: the setup chain must run
 * without being recorded, and recording must pick up from where it left the
 * browser. A real browser and a real cookie are the only way to prove that.
 */

const css = (selector: string): Target => ({
  candidates: [{ engine: 'css', value: selector, score: 40, source: 'recorded' }],
  primaryIndex: 0,
  frame: [],
  inShadowDom: false,
  description: selector,
});

/** An app that redirects to a login form until a session cookie is set. */
function startFixture(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    const signedIn = (request.headers.cookie ?? '').includes('auth=1');

    if (url === '/login' && request.method === 'POST') {
      request.resume();
      request.on('end', () => {
        response.writeHead(302, { 'set-cookie': 'auth=1; Path=/', location: '/' });
        response.end();
      });
      return;
    }

    if (url.startsWith('/login')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        `<!doctype html><form method="post" action="/login">
           <input id="username" name="username">
           <input id="password" name="password" type="password">
           <button id="submit" type="submit">Sign in</button>
         </form>`,
      );
      return;
    }

    if (!signedIn) {
      response.writeHead(302, { location: '/login' });
      response.end();
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      `<!doctype html><h1 id="home">Dashboard</h1>
       <button id="new-order" data-testid="new-order">New order</button>`,
    );
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;

      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('recording from a chain of existing tests', () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let store: ProjectStore;
  let environment: Environment;
  let login: TestCase;
  let openOrders: TestCase;

  beforeAll(async () => {
    fixture = await startFixture();

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowcase-chain-'));
    store = await ProjectStore.init(root, { name: 'chain', baseUrl: fixture.baseUrl });

    const existing = await store.getDefaultEnvironment();
    environment = await store.saveEnvironment({ ...existing, baseUrl: fixture.baseUrl, headless: true });

    login = await store.saveTest(
      createTest({
        name: 'Log in',
        defaultTimeoutMs: 5000,
        steps: [
          createStep('goto', { value: '/login' }),
          createStep('fill', { target: css('#username'), value: 'admin' }),
          createStep('fill', { target: css('#password'), value: 'secret' }),
          createStep('click', { target: css('#submit') }),
          createStep('assertVisible', { target: css('#home') }),
        ],
      }),
    );

    openOrders = await store.saveTest(
      createTest({
        name: 'Open the dashboard',
        dependsOn: [login.id],
        defaultTimeoutMs: 5000,
        steps: [createStep('assertText', { target: css('#home'), value: 'Dashboard', matcher: 'contains' })],
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
  });

  it('runs the chain without recording it, then records from where it ended', async () => {
    const session = await RecorderSession.start({
      store,
      environment,
      headless: true,
      toolbar: false,
      prerequisiteTestIds: [login.id],
    });

    try {
      // Everything the login test clicked belongs to that test, not this recording.
      expect(session.steps).toEqual([]);
      expect(session.prerequisiteTestIds).toEqual([login.id]);
      expect(session.setup?.results.map((result) => result.status)).toEqual(['passed']);

      const page = session.activePage;
      expect(page).toBeDefined();

      // The cookie the chain obtained is still in force.
      expect(await page?.textContent('#home')).toBe('Dashboard');

      await page?.click('#new-order');

      await expect.poll(() => session.steps.length, { timeout: 5000 }).toBeGreaterThan(0);
      expect(session.steps[0]?.kind).toBe('click');
    } finally {
      await session.stop();
    }
  }, 60_000);

  it("pulls in a prerequisite's own dependencies, in order", async () => {
    const session = await RecorderSession.start({
      store,
      environment,
      headless: true,
      toolbar: false,
      prerequisiteTestIds: [openOrders.id],
    });

    try {
      expect(session.prerequisiteTestIds).toEqual([login.id, openOrders.id]);
      expect(session.steps).toEqual([]);
    } finally {
      await session.stop();
    }
  }, 60_000);

  it('refuses to start recording when a setup test fails', async () => {
    const broken = await store.saveTest(
      createTest({
        name: 'Never passes',
        defaultTimeoutMs: 1000,
        steps: [
          createStep('goto', { value: '/login' }),
          createStep('assertVisible', { target: css('#does-not-exist') }),
        ],
      }),
    );

    await expect(
      RecorderSession.start({
        store,
        environment,
        headless: true,
        toolbar: false,
        prerequisiteTestIds: [broken.id],
      }),
    ).rejects.toThrow(PrerequisiteFailedError);
  }, 60_000);

  it('ripples where the tester clicks, confirming the action was captured', async () => {
    const session = await RecorderSession.start({
      store,
      environment,
      headless: true,
      toolbar: false,
      // Normally tied to a headed window; forced on so this can run in CI.
      highlight: true,
      startUrl: '/login',
    });

    try {
      const page = session.activePage;
      // An input, not the submit button — a navigation would wipe the ripple.
      await page?.click('#username');

      await expect.poll(() => page?.locator('.__flowcase_ripple').count(), { timeout: 5000 }).toBe(1);
      await expect.poll(() => session.steps.length, { timeout: 5000 }).toBeGreaterThan(1);
    } finally {
      await session.stop();
    }
  }, 60_000);

  it('leaves the page alone when highlighting is off', async () => {
    const session = await RecorderSession.start({
      store,
      environment,
      headless: true,
      toolbar: false,
      highlight: false,
      startUrl: '/login',
    });

    try {
      const page = session.activePage;
      await page?.click('#username');

      await expect.poll(() => session.steps.length, { timeout: 5000 }).toBeGreaterThan(1);
      expect(await page?.locator('.__flowcase_ripple').count()).toBe(0);
    } finally {
      await session.stop();
    }
  }, 60_000);

  it('still records normally when no chain is requested', async () => {
    const session = await RecorderSession.start({
      store,
      environment,
      headless: true,
      toolbar: false,
      startUrl: '/login',
    });

    try {
      expect(session.prerequisiteTestIds).toEqual([]);
      expect(session.setup).toBeUndefined();
      // The explicit start URL is recorded, as it always was.
      expect(session.steps.map((step) => step.kind)).toEqual(['goto']);
    } finally {
      await session.stop();
    }
  }, 60_000);
});
