import type { FrameLocator, Locator, Page } from 'playwright';
import type { FrameHop, SelectorCandidate, Target } from '../model/selector.js';

/** Anything that can host `getBy*` queries — the page itself or an iframe. */
export type LocatorRoot = Page | FrameLocator;

type RoleName = Parameters<Page['getByRole']>[0];

/** Walks the iframe chain outside-in and returns the innermost root. */
export function resolveFrameRoot(page: Page, frame: FrameHop[]): LocatorRoot {
  let root: LocatorRoot = page;

  for (const hop of frame) {
    root = root.frameLocator(frameSelector(hop));
  }

  return root;
}

function frameSelector(hop: FrameHop): string {
  switch (hop.kind) {
    case 'url':
      return `iframe[src*="${cssEscapeAttribute(hop.value)}"]`;
    case 'name':
      return `iframe[name="${cssEscapeAttribute(hop.value)}"]`;
    case 'selector':
      return hop.value;
  }
}

/** Builds a Playwright locator for one candidate strategy. */
export function buildLocator(root: LocatorRoot, candidate: SelectorCandidate): Locator {
  const exact = candidate.exact ?? false;
  let locator: Locator;

  switch (candidate.engine) {
    case 'testid':
      locator = root.getByTestId(candidate.value);
      break;
    case 'role':
      locator = root.getByRole(
        candidate.value as RoleName,
        candidate.name === undefined ? {} : { name: candidate.name, exact },
      );
      break;
    case 'label':
      locator = root.getByLabel(candidate.value, { exact });
      break;
    case 'placeholder':
      locator = root.getByPlaceholder(candidate.value, { exact });
      break;
    case 'altText':
      locator = root.getByAltText(candidate.value, { exact });
      break;
    case 'title':
      locator = root.getByTitle(candidate.value, { exact });
      break;
    case 'text':
      locator = root.getByText(candidate.value, { exact });
      break;
    case 'css':
      locator = root.locator(candidate.value);
      break;
    case 'xpath':
      locator = root.locator(`xpath=${candidate.value}`);
      break;
  }

  return candidate.nth === undefined ? locator : locator.nth(candidate.nth);
}

export function buildTargetLocator(page: Page, target: Target, candidate: SelectorCandidate): Locator {
  return buildLocator(resolveFrameRoot(page, target.frame), candidate);
}

function cssEscapeAttribute(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
