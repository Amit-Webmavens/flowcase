import { describe, expect, it } from 'vitest';
import { CyclicDependencyError, dependentsOf, detectCycles, matchesTags, planRun } from '../src/graph/plan.js';
import { createTest } from '../src/model/factory.js';
import type { TestCase } from '../src/model/test.js';

function make(name: string, overrides: Partial<TestCase> = {}): TestCase {
  return createTest({ id: `t_${name}`, name, ...overrides });
}

describe('planRun', () => {
  it('runs everything when nothing is requested', () => {
    const tests = [make('a'), make('b')];
    expect(planRun({ tests }).order).toHaveLength(2);
  });

  it('pulls in transitive dependencies of a single requested test', () => {
    const login = make('login');
    const order = make('order', { dependsOn: [login.id] });
    const item = make('item', { dependsOn: [order.id] });

    const plan = planRun({ tests: [login, order, item], requestedIds: [item.id] });

    expect(plan.order).toEqual([login.id, order.id, item.id]);
    expect(plan.requested).toEqual([item.id]);
    expect(plan.added).toEqual([login.id, order.id]);
  });

  it('always orders dependencies before dependants', () => {
    const first = make('zzz-first');
    const second = make('aaa-second', { dependsOn: [first.id] });

    const plan = planRun({ tests: [first, second] });

    expect(plan.order.indexOf(first.id)).toBeLessThan(plan.order.indexOf(second.id));
  });

  it('reports dependencies that no longer exist', () => {
    const orphan = make('orphan', { dependsOn: ['t_gone'] });
    const plan = planRun({ tests: [orphan], requestedIds: [orphan.id] });

    expect(plan.missing).toEqual(['t_gone']);
  });

  it('filters by tag, including exclusions', () => {
    const smoke = make('smoke', { tags: ['smoke'] });
    const slow = make('slow', { tags: ['smoke', 'slow'] });

    expect(planRun({ tests: [smoke, slow], tags: ['smoke'] }).order).toHaveLength(2);
    expect(planRun({ tests: [smoke, slow], tags: ['smoke', '!slow'] }).order).toEqual([smoke.id]);
  });

  it('can exclude tests that are not approved', () => {
    const approved = make('approved', { status: 'approved' });
    const draft = make('draft');

    const plan = planRun({ tests: [approved, draft], approvedOnly: true });

    expect(plan.order).toEqual([approved.id]);
    expect(plan.unapproved).toEqual([draft.id]);
  });

  it('is deterministic across calls', () => {
    const tests = [make('c'), make('a'), make('b')];

    expect(planRun({ tests }).order).toEqual(planRun({ tests }).order);
  });

  it('throws a readable error on a dependency loop', () => {
    const a = make('a');
    const b = make('b', { dependsOn: [a.id] });
    a.dependsOn = [b.id];

    expect(() => planRun({ tests: [a, b] })).toThrow(CyclicDependencyError);
  });
});

describe('detectCycles', () => {
  it('finds a loop without throwing', () => {
    const a = make('a');
    const b = make('b', { dependsOn: [a.id] });
    a.dependsOn = [b.id];

    expect(detectCycles([a, b])).toHaveLength(1);
  });

  it('returns nothing for an acyclic graph', () => {
    const a = make('a');
    const b = make('b', { dependsOn: [a.id] });

    expect(detectCycles([a, b])).toEqual([]);
  });
});

describe('dependentsOf', () => {
  it('finds direct and transitive dependants', () => {
    const login = make('login');
    const order = make('order', { dependsOn: [login.id] });
    const item = make('item', { dependsOn: [order.id] });
    const unrelated = make('unrelated');

    const affected = dependentsOf([login, order, item, unrelated], login.id);

    expect(affected.sort()).toEqual([item.id, order.id].sort());
  });
});

describe('matchesTags', () => {
  it('requires every listed tag', () => {
    const test = make('t', { tags: ['a', 'b'] });

    expect(matchesTags(test, ['a', 'b'])).toBe(true);
    expect(matchesTags(test, ['a', 'c'])).toBe(false);
    expect(matchesTags(test, ['!c'])).toBe(true);
    expect(matchesTags(test, ['!a'])).toBe(false);
  });
});
