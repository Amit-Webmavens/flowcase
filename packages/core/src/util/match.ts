/**
 * Turns a glob into a regular expression.
 *
 * `*` matches within a path segment, `**` crosses segments, `?` matches one
 * character. Patterns prefixed with `re:` are treated as raw regular
 * expressions instead.
 */
export function globToRegExp(pattern: string): RegExp {
  if (pattern.startsWith('re:')) {
    return new RegExp(pattern.slice(3));
  }

  let source = '';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';

    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (character === '?') {
      source += '.';
      continue;
    }

    source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${source}$`);
}

/**
 * Matches a URL against a pattern. Bare patterns are also tried as a substring
 * match, so `/api/orders` works without the caller writing `**\/api/orders`.
 */
export function matchUrl(pattern: string, url: string): boolean {
  if (pattern.length === 0) {
    return false;
  }

  if (globToRegExp(pattern).test(url)) {
    return true;
  }

  if (pattern.startsWith('re:')) {
    return false;
  }

  return !pattern.includes('*') && url.includes(pattern);
}

export type TextMatcher = 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'regex' | 'notContains';

/** Whitespace-normalised comparison — the DOM is generous with newlines. */
export function matchText(matcher: TextMatcher, actual: string, expected: string): boolean {
  const left = actual.replace(/\s+/g, ' ').trim();
  const right = expected.replace(/\s+/g, ' ').trim();

  switch (matcher) {
    case 'equals':
      return left === right;
    case 'contains':
      return left.includes(right);
    case 'startsWith':
      return left.startsWith(right);
    case 'endsWith':
      return left.endsWith(right);
    case 'notContains':
      return !left.includes(right);
    case 'regex':
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
  }
}

export function describeMatcher(matcher: TextMatcher): string {
  switch (matcher) {
    case 'equals':
      return 'equal';
    case 'contains':
      return 'contain';
    case 'startsWith':
      return 'start with';
    case 'endsWith':
      return 'end with';
    case 'notContains':
      return 'not contain';
    case 'regex':
      return 'match';
  }
}
