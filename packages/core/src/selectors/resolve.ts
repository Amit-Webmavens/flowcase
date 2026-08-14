import type { Locator, Page } from 'playwright';
import type { HealEvent } from '../model/run.js';
import type { ElementSnapshot, SelectorCandidate, Target } from '../model/selector.js';
import { describeCandidate } from '../model/selector.js';
import { buildLocator, resolveFrameRoot } from './locator.js';
import { elementSimilarity } from './similarity.js';

export type WaitState = 'attached' | 'detached' | 'visible' | 'hidden';

export interface ResolveOptions {
  timeoutMs: number;
  state?: WaitState;
  /** Try lower-ranked candidates when the primary stops matching. */
  allowHealing?: boolean;
  /** Minimum fingerprint confidence before a healed match is accepted. */
  minConfidence?: number;
  /** Per-candidate budget while probing fallbacks. Kept short — several may fail. */
  fallbackTimeoutMs?: number;
}

export interface ResolvedTarget {
  locator: Locator;
  candidate: SelectorCandidate;
  candidateIndex: number;
  selector: string;
  heal?: HealEvent;
}

export class TargetResolutionError extends Error {
  constructor(
    message: string,
    readonly attempts: Array<{ selector: string; reason: string }>,
  ) {
    super(message);
    this.name = 'TargetResolutionError';
  }
}

/** The primary locator with no waiting — for hidden/absent assertions. */
export function locatorFor(page: Page, target: Target): Locator {
  const root = resolveFrameRoot(page, target.frame);
  const candidate = target.candidates[target.primaryIndex] ?? target.candidates[0];

  if (!candidate) {
    throw new Error('Target has no selector candidates.');
  }

  return buildLocator(root, candidate);
}

/**
 * Finds the element a step refers to.
 *
 * The primary selector gets the full timeout. If it stops matching — the usual
 * symptom of a UI change — each remaining candidate is probed briefly, and any
 * element found is fingerprinted and compared against what was recorded. A match
 * is only accepted when the fingerprint is convincing, so healing repairs a
 * renamed button rather than silently clicking an unrelated one.
 */
export async function resolveTarget(
  page: Page,
  target: Target,
  options: ResolveOptions,
): Promise<ResolvedTarget> {
  const {
    timeoutMs,
    state = 'visible',
    allowHealing = true,
    minConfidence = 0.6,
    fallbackTimeoutMs = Math.min(2500, Math.max(500, Math.floor(timeoutMs / 4))),
  } = options;

  const root = resolveFrameRoot(page, target.frame);
  const attempts: Array<{ selector: string; reason: string }> = [];
  const ranked = rankCandidates(target);
  const [primary, ...fallbacks] = ranked;

  if (!primary) {
    throw new TargetResolutionError('Target has no selector candidates.', attempts);
  }

  const primaryLocator = buildLocator(root, primary.candidate);

  try {
    await primaryLocator.waitFor({ state, timeout: timeoutMs });

    return {
      locator: primaryLocator,
      candidate: primary.candidate,
      candidateIndex: primary.index,
      selector: describeCandidate(primary.candidate),
    };
  } catch (error) {
    attempts.push({ selector: describeCandidate(primary.candidate), reason: shortReason(error) });
  }

  if (!allowHealing || fallbacks.length === 0) {
    throw new TargetResolutionError(
      `Could not find ${describeCandidate(primary.candidate)} within ${timeoutMs}ms.`,
      attempts,
    );
  }

  let best:
    | { locator: Locator; candidate: SelectorCandidate; index: number; confidence: number }
    | undefined;

  for (const entry of fallbacks) {
    const locator = buildLocator(root, entry.candidate);

    try {
      await locator.waitFor({ state, timeout: fallbackTimeoutMs });
    } catch (error) {
      attempts.push({ selector: describeCandidate(entry.candidate), reason: shortReason(error) });
      continue;
    }

    const confidence = await confidenceFor(locator, target.snapshot);

    if (!best || confidence > best.confidence) {
      best = { locator, candidate: entry.candidate, index: entry.index, confidence };
    }

    // A near-perfect fingerprint is not going to be beaten; stop probing.
    if (confidence >= 0.95) {
      break;
    }
  }

  if (!best || best.confidence < minConfidence) {
    if (best) {
      attempts.push({
        selector: describeCandidate(best.candidate),
        reason: `matched a different element (confidence ${best.confidence.toFixed(2)} < ${minConfidence})`,
      });
    }

    throw new TargetResolutionError(
      `Could not find ${describeCandidate(primary.candidate)} within ${timeoutMs}ms, and no fallback selector matched the recorded element.`,
      attempts,
    );
  }

  return {
    locator: best.locator,
    candidate: best.candidate,
    candidateIndex: best.index,
    selector: describeCandidate(best.candidate),
    heal: {
      from: describeCandidate(primary.candidate),
      to: describeCandidate(best.candidate),
      engine: best.candidate.engine,
      score: best.candidate.score,
      confidence: best.confidence,
      accepted: false,
    },
  };
}

function rankCandidates(target: Target): Array<{ candidate: SelectorCandidate; index: number }> {
  const entries = target.candidates.map((candidate, index) => ({ candidate, index }));
  const primary = entries[target.primaryIndex];
  const rest = entries
    .filter((entry) => entry.index !== target.primaryIndex)
    .sort((a, b) => b.candidate.score - a.candidate.score);

  return primary ? [primary, ...rest] : rest;
}

/**
 * Without a recorded fingerprint there is nothing to compare against, so healing
 * falls back to a neutral score: accepted only when the caller's threshold is
 * permissive.
 */
async function confidenceFor(locator: Locator, snapshot: ElementSnapshot | undefined): Promise<number> {
  if (!snapshot) {
    return 0.5;
  }

  try {
    const live = await fingerprintElement(locator);
    return elementSimilarity(snapshot, live);
  } catch {
    return 0;
  }
}

/**
 * Reads an element's identifying features in the page. Runs in the browser, so
 * the callback must stay self-contained.
 */
export async function fingerprintElement(locator: Locator): Promise<ElementSnapshot> {
  return locator.evaluate((node: Element): ElementSnapshot => {
    const element = node as HTMLElement;

    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      attributes[attribute.name] = attribute.value;
    }

    const implicitRole = (): string | undefined => {
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
        return 'textbox';
      }

      return undefined;
    };

    const accessibleName = (): string | undefined => {
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();

      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (text) return text;
      }

      const id = element.getAttribute('id');
      if (id) {
        const label = element.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label?.textContent) return label.textContent.trim();
      }

      const wrappingLabel = element.closest('label');
      if (wrappingLabel?.textContent) return wrappingLabel.textContent.trim();

      const alt = element.getAttribute('alt');
      if (alt) return alt.trim();

      const title = element.getAttribute('title');
      if (title) return title.trim();

      const placeholder = element.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();

      // Form controls are named by their label, not their contents — a <select>'s
      // text is just its option list. Must match the recorder's rule exactly, or
      // healing would compare fingerprints built by different definitions.
      const tag = element.tagName.toLowerCase();
      if (tag === 'select' || tag === 'input' || tag === 'textarea') {
        return undefined;
      }

      return (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined;
    };

    const siblings = element.parentElement
      ? Array.from(element.parentElement.children).filter((child) => child.tagName === element.tagName)
      : [];

    const rect = element.getBoundingClientRect();

    return {
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute('role') ?? implicitRole(),
      accessibleName: accessibleName(),
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      elementId: element.id || undefined,
      classes: Array.from(element.classList),
      attributes,
      inputType: element.getAttribute('type') ?? undefined,
      siblingIndex: siblings.indexOf(element),
      boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
}

/** Promotes a healed candidate to primary so future runs use it directly. */
export function applyHeal(target: Target, healedSelectorDescription: string): Target {
  const index = target.candidates.findIndex(
    (candidate) => describeCandidate(candidate) === healedSelectorDescription,
  );

  if (index < 0) {
    return target;
  }

  const candidates = target.candidates.map((candidate, position) =>
    position === index ? { ...candidate, source: 'healed' as const } : candidate,
  );

  return { ...target, candidates, primaryIndex: index };
}

function shortReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [firstLine = ''] = message.split('\n');

  if (message.includes('strict mode violation')) {
    return 'matched more than one element';
  }

  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'not found in time';
  }

  return firstLine.slice(0, 160);
}
