import { z } from 'zod';

/**
 * Selector strategies, ordered from most to least resilient. The recorder emits
 * every strategy it can derive for an element; the engine walks them in score
 * order and heals to a lower-ranked one when the primary stops matching.
 */
export const SELECTOR_ENGINES = [
  'testid',
  'role',
  'label',
  'placeholder',
  'altText',
  'title',
  'text',
  'css',
  'xpath',
] as const;

export type SelectorEngine = (typeof SELECTOR_ENGINES)[number];

/**
 * Baseline stability score per engine. The recorder adjusts these using what it
 * observes on the page (uniqueness, whether an id looks generated, and so on).
 */
export const ENGINE_BASE_SCORE: Record<SelectorEngine, number> = {
  testid: 100,
  role: 85,
  label: 80,
  placeholder: 70,
  altText: 65,
  title: 60,
  text: 55,
  css: 40,
  xpath: 20,
};

export const SelectorCandidateSchema = z.object({
  engine: z.enum(SELECTOR_ENGINES),
  /**
   * Selector body. For `role` this is the ARIA role; for `css`/`xpath` the raw
   * expression. Deliberately allowed to be empty: the editor creates a blank
   * candidate for the tester to fill in, and completeness is enforced by
   * `validateStep` rather than by the schema.
   */
  value: z.string(),
  /** Accessible name, used by the role/label/text engines. */
  name: z.string().optional(),
  /** Whether `name`/text matching must be exact rather than substring. */
  exact: z.boolean().optional(),
  /** Disambiguation index when the selector legitimately matches several elements. */
  nth: z.number().int().min(0).optional(),
  /** 0–100 stability estimate; higher wins. */
  score: z.number().min(0).max(100),
  source: z.enum(['recorded', 'healed', 'manual']).default('recorded'),
});

export type SelectorCandidate = z.infer<typeof SelectorCandidateSchema>;

/**
 * One hop in an iframe chain. Steps inside nested frames carry the full chain so
 * the engine can rebuild `frameLocator()` calls from the outside in.
 */
export const FrameHopSchema = z.object({
  kind: z.enum(['url', 'name', 'selector']),
  value: z.string(),
});

export type FrameHop = z.infer<typeof FrameHopSchema>;

/**
 * What the element looked like when it was recorded. Healing compares live
 * candidates against this fingerprint to decide whether a match is the same
 * element or a coincidental one.
 */
export const ElementSnapshotSchema = z.object({
  tagName: z.string(),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  text: z.string().optional(),
  elementId: z.string().optional(),
  classes: z.array(z.string()).default([]),
  attributes: z.record(z.string(), z.string()).default({}),
  inputType: z.string().optional(),
  /** Index among same-tag siblings — a weak but useful positional hint. */
  siblingIndex: z.number().int().optional(),
  boundingBox: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional(),
});

export type ElementSnapshot = z.infer<typeof ElementSnapshotSchema>;

export const TargetSchema = z.object({
  candidates: z.array(SelectorCandidateSchema),
  /** Index into `candidates` to try first. Healing rewrites this, not the array. */
  primaryIndex: z.number().int().min(0).default(0),
  /** Outermost-to-innermost iframe chain. Empty for main-frame elements. */
  frame: z.array(FrameHopSchema).default([]),
  /** True when the element lives inside a shadow root; Playwright pierces these by default. */
  inShadowDom: z.boolean().default(false),
  snapshot: ElementSnapshotSchema.optional(),
  /** Human description shown in the no-code editor, e.g. `button "Save order"`. */
  description: z.string().optional(),
});

export type Target = z.infer<typeof TargetSchema>;

/** Candidates ordered by score, with the designated primary pulled to the front. */
export function orderedCandidates(target: Target): SelectorCandidate[] {
  const primary = target.candidates[target.primaryIndex];
  const rest = target.candidates
    .filter((_, index) => index !== target.primaryIndex)
    .slice()
    .sort((a, b) => b.score - a.score);

  return primary ? [primary, ...rest] : rest;
}

/** Compact, readable form used in logs, run reports and the step editor. */
export function describeCandidate(candidate: SelectorCandidate): string {
  switch (candidate.engine) {
    case 'role':
      return candidate.name
        ? `role=${candidate.value}[name="${candidate.name}"]`
        : `role=${candidate.value}`;
    case 'testid':
      return `testid=${candidate.value}`;
    case 'label':
      return `label="${candidate.value}"`;
    case 'placeholder':
      return `placeholder="${candidate.value}"`;
    case 'altText':
      return `alt="${candidate.value}"`;
    case 'title':
      return `title="${candidate.value}"`;
    case 'text':
      return `text="${candidate.value}"`;
    case 'css':
      return candidate.value;
    case 'xpath':
      return `xpath=${candidate.value}`;
  }
}

export function describeTarget(target: Target): string {
  if (target.description) {
    return target.description;
  }

  const primary = target.candidates[target.primaryIndex] ?? target.candidates[0];

  return primary ? describeCandidate(primary) : '(no selector)';
}
