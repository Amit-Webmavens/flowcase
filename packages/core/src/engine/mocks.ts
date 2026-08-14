import type { Page, Route } from 'playwright';
import type { RouteMock } from '../model/step.js';
import { interpolate } from '../variables/interpolate.js';
import type { VariableScope } from '../variables/scope.js';
import { matchUrl } from '../util/match.js';

/**
 * Manages network stubs for one page.
 *
 * Mocks can come from the test (applied before the first step) or from
 * `mockRoute` steps mid-test, and can be removed again. Handlers are tracked by
 * mock id so `unmockRoute` can detach exactly one.
 */
export class MockRegistry {
  private readonly active = new Map<string, (route: Route) => Promise<void>>();
  private readonly served = new Map<string, number>();

  constructor(private readonly page: Page) {}

  async apply(mock: RouteMock, scope: VariableScope): Promise<void> {
    if (!mock.enabled) {
      return;
    }

    await this.remove(mock.id);

    const pattern = interpolate(mock.urlPattern, scope, { onMissing: 'empty' });

    const handler = async (route: Route): Promise<void> => {
      const request = route.request();

      if (mock.method !== 'ANY' && request.method().toUpperCase() !== mock.method) {
        await route.fallback();
        return;
      }

      if (!matchUrl(pattern, request.url())) {
        await route.fallback();
        return;
      }

      const count = this.served.get(mock.id) ?? 0;

      if (mock.times > 0 && count >= mock.times) {
        await route.fallback();
        return;
      }

      this.served.set(mock.id, count + 1);

      if (mock.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
      }

      if (mock.abort) {
        await route.abort('failed');
        return;
      }

      await route.fulfill({
        status: mock.status,
        contentType: mock.contentType,
        headers: mock.headers,
        body: interpolate(mock.body, scope, { onMissing: 'empty' }),
      });
    };

    this.active.set(mock.id, handler);

    // Register against everything and filter inside the handler: the stored
    // pattern is a glob over the full URL, which Playwright's matcher does not
    // interpret the same way.
    await this.page.route('**/*', handler);
  }

  /** Removes a mock by id, or by the URL pattern a `unmockRoute` step names. */
  async remove(idOrPattern: string): Promise<boolean> {
    const handler = this.active.get(idOrPattern);

    if (handler) {
      await this.page.unroute('**/*', handler);
      this.active.delete(idOrPattern);
      this.served.delete(idOrPattern);
      return true;
    }

    return false;
  }

  async removeAll(): Promise<void> {
    for (const id of [...this.active.keys()]) {
      await this.remove(id);
    }
  }

  get activeIds(): string[] {
    return [...this.active.keys()];
  }
}
