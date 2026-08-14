import { newId } from '../model/common.js';
import type { Step } from '../model/step.js';
import type { Snippet } from '../model/test.js';

/**
 * Expands `snippet` steps into the fragment's own steps.
 *
 * Each expansion becomes a `group` carrying the snippet's arguments, so the
 * executor can push a child variable scope: a snippet parameter named `email`
 * resolves to the bound argument inside the fragment without leaking outside it.
 * Step ids are regenerated per expansion so the same snippet can appear twice in
 * one test and still produce distinct result rows.
 */
export function inlineSnippets(steps: Step[], snippets: Map<string, Snippet>): Step[] {
  return steps.flatMap((step) => {
    if (step.kind !== 'snippet') {
      return [{ ...step, children: inlineSnippets(step.children, snippets) }];
    }

    const snippet = step.snippetId ? snippets.get(step.snippetId) : undefined;

    if (!snippet) {
      // Leave it in place: validation reports the broken reference, and the
      // executor fails the step with a clear message rather than skipping it.
      return [step];
    }

    const defaults = Object.fromEntries(
      snippet.parameters.map((parameter) => [parameter.name, parameter.defaultValue]),
    );

    const group: Step = {
      ...step,
      kind: 'group',
      label: step.label.length > 0 ? step.label : snippet.name,
      value: snippet.name,
      snippetArgs: { ...defaults, ...step.snippetArgs },
      children: regenerateIds(snippet.steps),
    };

    return [group];
  });
}

function regenerateIds(steps: Step[]): Step[] {
  return steps.map((step) => ({
    ...step,
    id: newId('st'),
    children: regenerateIds(step.children),
  }));
}

/** Snippet ids a test references, including those nested inside groups. */
export function referencedSnippetIds(steps: Step[]): string[] {
  const ids = new Set<string>();

  const walk = (list: Step[]): void => {
    for (const step of list) {
      if (step.kind === 'snippet' && step.snippetId) {
        ids.add(step.snippetId);
      }

      walk(step.children);
    }
  };

  walk(steps);

  return [...ids];
}
