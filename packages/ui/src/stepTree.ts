import type { Step } from '@flowcase/core/model';

/**
 * Immutable helpers for the step tree the editor renders.
 *
 * Steps nest (a group holds children), so every operation recurses. Returning
 * new arrays rather than mutating keeps React re-rendering predictable.
 */

export function updateStep(steps: Step[], id: string, update: (step: Step) => Step): Step[] {
  return steps.map((step) => {
    if (step.id === id) {
      return update(step);
    }

    if (step.children.length > 0) {
      return { ...step, children: updateStep(step.children, id, update) };
    }

    return step;
  });
}

export function removeStep(steps: Step[], id: string): Step[] {
  return steps
    .filter((step) => step.id !== id)
    .map((step) => (step.children.length > 0 ? { ...step, children: removeStep(step.children, id) } : step));
}

/** Moves a step within its own sibling list; it never jumps between groups. */
export function moveStep(steps: Step[], id: string, direction: -1 | 1): Step[] {
  const index = steps.findIndex((step) => step.id === id);

  if (index >= 0) {
    const target = index + direction;

    if (target < 0 || target >= steps.length) {
      return steps;
    }

    const next = [...steps];
    const [moved] = next.splice(index, 1);

    if (moved) {
      next.splice(target, 0, moved);
    }

    return next;
  }

  return steps.map((step) =>
    step.children.length > 0 ? { ...step, children: moveStep(step.children, id, direction) } : step,
  );
}

/** Inserts after `afterId`, or at the end of the top level when not given. */
export function insertStep(steps: Step[], step: Step, afterId?: string): Step[] {
  if (!afterId) {
    return [...steps, step];
  }

  const index = steps.findIndex((candidate) => candidate.id === afterId);

  if (index >= 0) {
    const next = [...steps];
    next.splice(index + 1, 0, step);
    return next;
  }

  return steps.map((candidate) =>
    candidate.children.length > 0
      ? { ...candidate, children: insertStep(candidate.children, step, afterId) }
      : candidate,
  );
}

/** Adds a step as the last child of a group. */
export function appendChild(steps: Step[], groupId: string, step: Step): Step[] {
  return steps.map((candidate) => {
    if (candidate.id === groupId) {
      return { ...candidate, children: [...candidate.children, step] };
    }

    return candidate.children.length > 0
      ? { ...candidate, children: appendChild(candidate.children, groupId, step) }
      : candidate;
  });
}

export function findStep(steps: Step[], id: string): Step | undefined {
  for (const step of steps) {
    if (step.id === id) {
      return step;
    }

    const found = findStep(step.children, id);

    if (found) {
      return found;
    }
  }

  return undefined;
}

export function flattenSteps(steps: Step[], depth = 0): Array<{ step: Step; depth: number }> {
  return steps.flatMap((step) => [{ step, depth }, ...flattenSteps(step.children, depth + 1)]);
}
