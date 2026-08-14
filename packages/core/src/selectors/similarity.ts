import type { ElementSnapshot } from '../model/selector.js';

/** Attributes that change for reasons unrelated to identity. */
const VOLATILE_ATTRIBUTES = new Set([
  'style',
  'class',
  'id',
  'value',
  'checked',
  'selected',
  'aria-expanded',
  'aria-selected',
  'aria-busy',
  'data-reactid',
  'data-react-checksum',
  'tabindex',
]);

/**
 * Ids and classes emitted by frameworks change on every build or render, so they
 * are worthless as identity evidence. Detects the common shapes: hashed suffixes,
 * long digit runs, and known framework prefixes.
 */
export function looksGenerated(value: string): boolean {
  if (value.length === 0) {
    return true;
  }

  const patterns = [
    /^:r[0-9a-z]+:?$/i, // React useId
    /^(mui|ember|radix|headlessui|reach|chakra|mantine)[-_]/i,
    /[0-9a-f]{8,}/i, // hashes
    /\d{4,}/, // long numeric runs
    /^[a-z]{1,3}[-_]?\d{3,}$/i,
    /^css-[0-9a-z]+$/i, // emotion / styled-components
    /^sc-[0-9a-z]+$/i,
  ];

  return patterns.some((pattern) => pattern.test(value));
}

function normalize(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Levenshtein distance, capped so pathological inputs cannot dominate a run. */
function levenshtein(a: string, b: string): number {
  const left = a.slice(0, 200);
  const right = b.slice(0, 200);

  if (left === right) {
    return 0;
  }

  if (left.length === 0 || right.length === 0) {
    return Math.max(left.length, right.length);
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }

    previous = current;
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
}

/** 0–1 similarity between two strings; 1 means identical after normalisation. */
export function textSimilarity(a: string | undefined, b: string | undefined): number {
  const left = normalize(a);
  const right = normalize(b);

  if (left.length === 0 && right.length === 0) {
    return 1;
  }

  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  // Containment scores highly: labels often gain a suffix such as a count badge.
  if (left.includes(right) || right.includes(left)) {
    return 0.85;
  }

  const distance = levenshtein(left, right);
  const longest = Math.max(left.length, right.length);

  return Math.max(0, 1 - distance / longest);
}

function setOverlap(a: string[], b: string[]): number {
  const left = new Set(a.filter((value) => !looksGenerated(value)));
  const right = new Set(b.filter((value) => !looksGenerated(value)));

  if (left.size === 0 && right.size === 0) {
    return 1;
  }

  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const value of left) {
    if (right.has(value)) {
      shared += 1;
    }
  }

  return shared / Math.max(left.size, right.size);
}

function stableAttributes(attributes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !VOLATILE_ATTRIBUTES.has(key) && !key.startsWith('ng-')),
  );
}

interface Weighted {
  weight: number;
  score: number;
}

/**
 * Confidence, 0–1, that two element fingerprints describe the same element.
 * Used when a fallback selector matches something: a high score means the page
 * changed its markup, a low score means the selector found a different element
 * entirely and healing should be refused.
 */
export function elementSimilarity(recorded: ElementSnapshot, live: ElementSnapshot): number {
  const parts: Weighted[] = [
    { weight: 0.25, score: recorded.tagName.toLowerCase() === live.tagName.toLowerCase() ? 1 : 0 },
    { weight: 0.15, score: recorded.role && live.role ? (recorded.role === live.role ? 1 : 0) : 0.5 },
    { weight: 0.25, score: textSimilarity(recorded.accessibleName, live.accessibleName) },
    { weight: 0.15, score: textSimilarity(recorded.text, live.text) },
    { weight: 0.05, score: idScore(recorded.elementId, live.elementId) },
    { weight: 0.05, score: setOverlap(recorded.classes, live.classes) },
    {
      weight: 0.1,
      score: attributeScore(stableAttributes(recorded.attributes), stableAttributes(live.attributes)),
    },
  ];

  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  const weighted = parts.reduce((sum, part) => sum + part.weight * part.score, 0);

  return Number((weighted / total).toFixed(4));
}

function idScore(recorded: string | undefined, live: string | undefined): number {
  if (!recorded || !live) {
    return 0.5;
  }

  if (looksGenerated(recorded) || looksGenerated(live)) {
    return 0.5;
  }

  return recorded === live ? 1 : 0;
}

function attributeScore(recorded: Record<string, string>, live: Record<string, string>): number {
  const keys = new Set([...Object.keys(recorded), ...Object.keys(live)]);

  if (keys.size === 0) {
    return 1;
  }

  let matched = 0;

  for (const key of keys) {
    if (recorded[key] !== undefined && recorded[key] === live[key]) {
      matched += 1;
    }
  }

  return matched / keys.size;
}
