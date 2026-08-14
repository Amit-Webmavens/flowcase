import { describe, expect, it } from 'vitest';
import { globToRegExp, matchText, matchUrl } from '../src/util/match.js';

describe('globToRegExp', () => {
  it('treats * as within-segment and ** as crossing segments', () => {
    expect(globToRegExp('/api/*').test('/api/orders')).toBe(true);
    expect(globToRegExp('/api/*').test('/api/orders/1')).toBe(false);
    expect(globToRegExp('/api/**').test('/api/orders/1')).toBe(true);
  });

  it('supports raw regular expressions behind re:', () => {
    expect(globToRegExp('re:^/orders/\\d+$').test('/orders/42')).toBe(true);
    expect(globToRegExp('re:^/orders/\\d+$').test('/orders/abc')).toBe(false);
  });

  it('escapes regex metacharacters in plain globs', () => {
    expect(globToRegExp('/a.b').test('/a.b')).toBe(true);
    expect(globToRegExp('/a.b').test('/axb')).toBe(false);
  });
});

describe('matchUrl', () => {
  it('matches a full URL against a glob', () => {
    expect(matchUrl('**/api/orders', 'https://app.test/api/orders')).toBe(true);
    expect(matchUrl('**/orders/**', 'https://app.test/orders/42?x=1')).toBe(true);
  });

  it('falls back to a substring match for bare patterns', () => {
    expect(matchUrl('/api/orders', 'https://app.test/api/orders?page=2')).toBe(true);
  });

  it('does not substring-match when the pattern has wildcards', () => {
    expect(matchUrl('/api/*', 'https://app.test/api/orders')).toBe(false);
  });

  it('rejects an empty pattern', () => {
    expect(matchUrl('', 'https://app.test')).toBe(false);
  });
});

describe('matchText', () => {
  it('normalises whitespace before comparing', () => {
    expect(matchText('equals', '  Order   created ', 'Order created')).toBe(true);
  });

  it('supports every matcher', () => {
    expect(matchText('contains', 'Order 42 created', '42')).toBe(true);
    expect(matchText('startsWith', 'Order 42', 'Order')).toBe(true);
    expect(matchText('endsWith', 'Order 42', '42')).toBe(true);
    expect(matchText('notContains', 'Order 42', 'error')).toBe(true);
    expect(matchText('regex', 'Order 42', '\\d+')).toBe(true);
  });

  it('returns false for an invalid regular expression rather than throwing', () => {
    expect(matchText('regex', 'anything', '([')).toBe(false);
  });
});
