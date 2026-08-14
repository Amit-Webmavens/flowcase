import { describe, expect, it } from 'vitest';
import type { ElementSnapshot } from '../src/model/selector.js';
import { describeCandidate, orderedCandidates } from '../src/model/selector.js';
import { elementSimilarity, looksGenerated, textSimilarity } from '../src/selectors/similarity.js';

const base: ElementSnapshot = {
  tagName: 'button',
  role: 'button',
  accessibleName: 'Save order',
  text: 'Save order',
  elementId: 'save-order',
  classes: ['btn', 'btn-primary'],
  attributes: { type: 'submit', 'data-testid': 'save' },
  siblingIndex: 0,
};

describe('looksGenerated', () => {
  it('recognises framework and hashed identifiers', () => {
    expect(looksGenerated('css-1x2y3z')).toBe(true);
    expect(looksGenerated('mui-12345')).toBe(true);
    expect(looksGenerated(':r3:')).toBe(true);
    expect(looksGenerated('a1b2c3d4e5')).toBe(true);
    expect(looksGenerated('item-4821')).toBe(true);
  });

  it('accepts human-written names', () => {
    expect(looksGenerated('save-order')).toBe(false);
    expect(looksGenerated('primary-button')).toBe(false);
  });
});

describe('textSimilarity', () => {
  it('scores identical text as 1', () => {
    expect(textSimilarity('Save order', 'Save order')).toBe(1);
  });

  it('ignores whitespace and case differences', () => {
    expect(textSimilarity('  Save   order ', 'save order')).toBe(1);
  });

  it('scores containment highly', () => {
    expect(textSimilarity('Save order', 'Save order (3)')).toBeGreaterThan(0.8);
  });

  it('scores unrelated text low', () => {
    expect(textSimilarity('Save order', 'Delete customer')).toBeLessThan(0.4);
  });
});

describe('elementSimilarity', () => {
  it('scores an unchanged element as a near-perfect match', () => {
    expect(elementSimilarity(base, base)).toBeGreaterThan(0.99);
  });

  it('still recognises an element after a class rename', () => {
    const restyled: ElementSnapshot = { ...base, classes: ['button', 'button--primary'] };

    expect(elementSimilarity(base, restyled)).toBeGreaterThan(0.8);
  });

  it('recognises an element whose label gained a suffix', () => {
    const relabelled: ElementSnapshot = {
      ...base,
      accessibleName: 'Save order (2 items)',
      text: 'Save order (2 items)',
    };

    expect(elementSimilarity(base, relabelled)).toBeGreaterThan(0.75);
  });

  it('rejects a completely different element', () => {
    const other: ElementSnapshot = {
      tagName: 'a',
      role: 'link',
      accessibleName: 'Delete customer',
      text: 'Delete customer',
      elementId: 'delete',
      classes: ['danger'],
      attributes: { href: '/delete' },
      siblingIndex: 4,
    };

    expect(elementSimilarity(base, other)).toBeLessThan(0.4);
  });

  it('does not credit generated ids as evidence of identity', () => {
    const withGeneratedId: ElementSnapshot = { ...base, elementId: 'css-99aabb' };
    const otherGeneratedId: ElementSnapshot = { ...base, elementId: 'css-11ccdd' };

    // Same element, different build hash — the score must stay high.
    expect(elementSimilarity(withGeneratedId, otherGeneratedId)).toBeGreaterThan(0.9);
  });
});

describe('candidate ordering', () => {
  it('puts the designated primary first, then the rest by score', () => {
    const ordered = orderedCandidates({
      candidates: [
        { engine: 'css', value: '.a', score: 40, source: 'recorded' },
        { engine: 'testid', value: 'save', score: 100, source: 'recorded' },
        { engine: 'role', value: 'button', score: 85, source: 'recorded' },
      ],
      primaryIndex: 0,
      frame: [],
      inShadowDom: false,
    });

    expect(ordered.map((candidate) => candidate.engine)).toEqual(['css', 'testid', 'role']);
  });
});

describe('describeCandidate', () => {
  it('renders each engine readably', () => {
    expect(describeCandidate({ engine: 'testid', value: 'save', score: 100, source: 'recorded' })).toBe('testid=save');
    expect(
      describeCandidate({ engine: 'role', value: 'button', name: 'Save', score: 85, source: 'recorded' }),
    ).toBe('role=button[name="Save"]');
    expect(describeCandidate({ engine: 'css', value: '#id', score: 40, source: 'recorded' })).toBe('#id');
  });
});
