import type { TestCase } from '../model/test.js';

export class CyclicDependencyError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Tests depend on each other in a loop: ${cycle.join(' → ')}`);
    this.name = 'CyclicDependencyError';
  }
}

export interface PlanRunOptions {
  /** Every test in the project — the graph is resolved against this set. */
  tests: TestCase[];
  /** Ids the user explicitly asked to run. Empty means "everything". */
  requestedIds?: string[];
  /** Pull in each requested test's transitive dependencies. */
  includeDependencies?: boolean;
  /** Keep only tests carrying every listed tag; `!tag` excludes. */
  tags?: string[];
  /** Skip tests that are not approved. */
  approvedOnly?: boolean;
}

export interface RunPlan {
  /** Execution order — dependencies always precede their dependants. */
  order: string[];
  /** What the user asked for, after tag filtering. */
  requested: string[];
  /** Dependencies added automatically. */
  added: string[];
  /** `dependsOn` ids with no matching test. */
  missing: string[];
  /** Tests excluded because they are not approved. */
  unapproved: string[];
}

/**
 * Works out what to run and in what order.
 *
 * Running a single test transparently pulls in the tests it builds on, so a
 * tester can hit "run" on "Add line item to order" without knowing it needs
 * "Log in" and "Create order" to have run first.
 */
export function planRun(options: PlanRunOptions): RunPlan {
  const { tests, requestedIds, includeDependencies = true, tags = [], approvedOnly = false } = options;

  const byId = new Map(tests.map((test) => [test.id, test]));
  const tagged = tags.length > 0 ? tests.filter((test) => matchesTags(test, tags)) : tests;

  const requested = (
    requestedIds && requestedIds.length > 0
      ? requestedIds.filter((id) => byId.has(id) && tagged.some((test) => test.id === id))
      : tagged.map((test) => test.id)
  ).slice();

  const missing = new Set<string>();
  const unapproved: string[] = [];
  const included = new Set<string>();

  const include = (id: string): void => {
    if (included.has(id)) {
      return;
    }

    const test = byId.get(id);

    if (!test) {
      missing.add(id);
      return;
    }

    included.add(id);

    if (includeDependencies) {
      for (const dependency of test.dependsOn) {
        include(dependency);
      }
    }
  };

  for (const id of requested) {
    include(id);
  }

  if (approvedOnly) {
    for (const id of [...included]) {
      const test = byId.get(id);

      if (test && test.status !== 'approved') {
        unapproved.push(id);
        included.delete(id);
      }
    }
  }

  const order = topologicalSort(
    [...included].map((id) => byId.get(id)).filter((test): test is TestCase => test !== undefined),
  );

  return {
    order,
    requested,
    added: order.filter((id) => !requested.includes(id)),
    missing: [...missing],
    unapproved,
  };
}

/**
 * Depth-first topological sort. Ties are broken by test name so the same project
 * always produces the same order — important for reproducible CI output.
 */
export function topologicalSort(tests: TestCase[]): string[] {
  const byId = new Map(tests.map((test) => [test.id, test]));
  const sorted: string[] = [];
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const path: string[] = [];

  const visit = (test: TestCase): void => {
    if (permanent.has(test.id)) {
      return;
    }

    if (temporary.has(test.id)) {
      const start = path.indexOf(test.id);
      const cycle = [...path.slice(start >= 0 ? start : 0), test.id].map(
        (id) => byId.get(id)?.name ?? id,
      );

      throw new CyclicDependencyError(cycle);
    }

    temporary.add(test.id);
    path.push(test.id);

    const dependencies = test.dependsOn
      .map((id) => byId.get(id))
      .filter((dependency): dependency is TestCase => dependency !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const dependency of dependencies) {
      visit(dependency);
    }

    path.pop();
    temporary.delete(test.id);
    permanent.add(test.id);
    sorted.push(test.id);
  };

  for (const test of [...tests].sort((a, b) => a.name.localeCompare(b.name))) {
    visit(test);
  }

  return sorted;
}

/** Every cycle in the project, for the editor to warn about before a run. */
export function detectCycles(tests: TestCase[]): string[][] {
  const cycles: string[][] = [];
  const byId = new Map(tests.map((test) => [test.id, test]));
  const visited = new Set<string>();

  const walk = (id: string, path: string[]): void => {
    if (path.includes(id)) {
      cycles.push([...path.slice(path.indexOf(id)), id].map((entry) => byId.get(entry)?.name ?? entry));
      return;
    }

    if (visited.has(id)) {
      return;
    }

    visited.add(id);
    const test = byId.get(id);

    for (const dependency of test?.dependsOn ?? []) {
      walk(dependency, [...path, id]);
    }
  };

  for (const test of tests) {
    walk(test.id, []);
  }

  return dedupeCycles(cycles);
}

/** Tests that would be affected by a change to `testId` — direct and transitive. */
export function dependentsOf(tests: TestCase[], testId: string): string[] {
  const dependants = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;

    for (const test of tests) {
      if (dependants.has(test.id)) {
        continue;
      }

      const dependsOnAffected = test.dependsOn.some(
        (dependency) => dependency === testId || dependants.has(dependency),
      );

      if (dependsOnAffected) {
        dependants.add(test.id);
        changed = true;
      }
    }
  }

  return [...dependants];
}

/** `tag` requires the tag; `!tag` excludes it. All conditions must hold. */
export function matchesTags(test: TestCase, tags: string[]): boolean {
  return tags.every((tag) => {
    if (tag.startsWith('!')) {
      return !test.tags.includes(tag.slice(1));
    }

    return test.tags.includes(tag);
  });
}

function dedupeCycles(cycles: string[][]): string[][] {
  const seen = new Set<string>();
  const unique: string[][] = [];

  for (const cycle of cycles) {
    const key = [...cycle].sort().join('|');

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(cycle);
    }
  }

  return unique;
}
