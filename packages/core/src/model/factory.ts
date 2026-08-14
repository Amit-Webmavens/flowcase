import { newId, nowIso } from './common.js';
import type { Step, StepKind } from './step.js';
import { StepSchema } from './step.js';
import type { Environment, ProjectConfig, Snippet, TestCase } from './test.js';
import { EnvironmentSchema, ProjectConfigSchema, SnippetSchema, TestCaseSchema } from './test.js';

/**
 * Builds a fully defaulted step. Everything that creates steps — the recorder,
 * the editor, snippet inlining — goes through here so no partially shaped step
 * ever reaches storage.
 */
export function createStep(kind: StepKind, overrides: Partial<Step> = {}): Step {
  return StepSchema.parse({
    id: overrides.id ?? newId('st'),
    kind,
    ...overrides,
  });
}

export function createTest(overrides: Partial<TestCase> = {}): TestCase {
  const timestamp = nowIso();

  return TestCaseSchema.parse({
    id: overrides.id ?? newId('t'),
    name: overrides.name ?? 'Untitled test',
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
    ...overrides,
  });
}

export function createSnippet(overrides: Partial<Snippet> = {}): Snippet {
  const timestamp = nowIso();

  return SnippetSchema.parse({
    id: overrides.id ?? newId('sn'),
    name: overrides.name ?? 'Untitled snippet',
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
    ...overrides,
  });
}

export function createEnvironment(overrides: Partial<Environment> = {}): Environment {
  const timestamp = nowIso();

  return EnvironmentSchema.parse({
    id: overrides.id ?? newId('env'),
    name: overrides.name ?? 'local',
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
    ...overrides,
  });
}

export function createProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  const timestamp = nowIso();

  return ProjectConfigSchema.parse({
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
    ...overrides,
  });
}
