import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStep, createTest } from '../src/model/factory.js';
import type { Run } from '../src/model/run.js';
import { ProjectStore } from '../src/storage/store.js';

let root: string;
let store: ProjectStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowcase-store-'));
  store = await ProjectStore.init(root, { name: 'test project', baseUrl: 'http://localhost:3000' });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('project setup', () => {
  it('creates a default environment and config', async () => {
    const config = await store.getConfig();
    const environments = await store.listEnvironments();

    expect(config.name).toBe('test project');
    expect(environments).toHaveLength(1);
    expect(environments[0]?.baseUrl).toBe('http://localhost:3000');
    expect(await store.getDefaultEnvironment()).toBeDefined();
  });

  it('finds the project from a nested directory', async () => {
    const nested = path.join(root, 'a', 'b');
    await fs.mkdir(nested, { recursive: true });

    const found = await ProjectStore.open(nested);

    expect(found.root).toBe(store.root);
  });
});

describe('tests', () => {
  it('stores a test under a readable slug', async () => {
    await store.saveTest(createTest({ name: 'Create an order' }));

    const files = await fs.readdir(store.testsDir);

    expect(files).toContain('create-an-order.json');
  });

  it('renames the file when the test is renamed', async () => {
    const saved = await store.saveTest(createTest({ name: 'First name' }));
    await store.saveTest({ ...saved, name: 'Second name' });

    const files = await fs.readdir(store.testsDir);

    expect(files).toEqual(['second-name.json']);
  });

  it('keeps two tests with the same name apart', async () => {
    await store.saveTest(createTest({ name: 'Duplicate' }));
    await store.saveTest(createTest({ name: 'Duplicate' }));

    expect(await fs.readdir(store.testsDir)).toHaveLength(2);
    expect(await store.listTests()).toHaveLength(2);
  });

  it('bumps the version and archives the previous one when content changes', async () => {
    const first = await store.saveTest(createTest({ name: 'Versioned' }));
    expect(first.version).toBe(1);

    const second = await store.saveTest({ ...first, steps: [createStep('goto', { value: '/' })] });
    expect(second.version).toBe(2);

    expect(await store.listTestVersions(first.id)).toEqual([2, 1]);

    const archived = await store.getTestVersion(first.id, 1);
    expect(archived?.steps).toHaveLength(0);
  });

  it('does not bump the version when nothing meaningful changed', async () => {
    const first = await store.saveTest(createTest({ name: 'Stable' }));
    const second = await store.saveTest(first);

    expect(second.version).toBe(1);
    expect(await store.listTestVersions(first.id)).toEqual([1]);
  });

  it('revokes approval when an approved test is edited', async () => {
    const approved = await store.saveTest(
      createTest({ name: 'Approved', status: 'approved', approval: { state: 'approved' } }),
    );

    const edited = await store.saveTest({ ...approved, steps: [createStep('reload')] });

    expect(edited.status).toBe('draft');
    expect(edited.approval.state).toBe('none');
  });

  it('leaves the version alone when only approval metadata changes', async () => {
    const test = await store.saveTest(createTest({ name: 'Metadata' }));

    const approved = await store.saveTest(
      { ...test, status: 'approved', approval: { ...test.approval, state: 'approved' } },
      { skipVersioning: true },
    );

    expect(approved.version).toBe(1);
    expect(approved.status).toBe('approved');
  });

  it('deletes the test and its history', async () => {
    const test = await store.saveTest(createTest({ name: 'Doomed' }));
    await store.saveTest({ ...test, steps: [createStep('reload')] });

    await store.deleteTest(test.id);

    expect(await store.getTest(test.id)).toBeUndefined();
    expect(await store.listTestVersions(test.id)).toEqual([]);
  });
});

describe('runs', () => {
  const makeRun = (id: string, status: Run['status']): Run => ({
    id,
    requestedTestIds: [],
    plan: [],
    status,
    dryRun: false,
    concurrency: 1,
    triggeredBy: 'cli',
    tagFilter: [],
    startedAt: new Date(Date.now() - Number(id.slice(1)) * 1000).toISOString(),
    durationMs: 10,
    results: [],
    variables: {},
  });

  it('lists an in-flight run before it finishes', async () => {
    await store.beginRun(makeRun('r1', 'running'));

    const runs = await store.listRuns();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('running');
  });

  it('moves a finished run into the index and out of the active list', async () => {
    const run = makeRun('r1', 'running');
    await store.beginRun(run);
    await store.completeRun({ ...run, status: 'passed' }, ['smoke']);

    const runs = await store.listRuns();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('passed');
    expect(runs[0]?.tags).toEqual(['smoke']);
  });

  it('returns runs newest first', async () => {
    for (const id of ['r3', 'r2', 'r1']) {
      const run = makeRun(id, 'running');
      await store.beginRun(run);
      await store.completeRun({ ...run, status: 'passed' });
    }

    const runs = await store.listRuns();

    expect(runs.map((entry) => entry.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('prunes old runs beyond the retention limit', async () => {
    const config = await store.getConfig();
    await store.saveConfig({ ...config, runRetention: 2 });

    for (const id of ['r5', 'r4', 'r3', 'r2', 'r1']) {
      const run = makeRun(id, 'running');
      await store.beginRun(run);
      await store.completeRun({ ...run, status: 'passed' });
    }

    const runs = await store.listRuns();

    expect(runs).toHaveLength(2);
    expect(runs.map((entry) => entry.id)).toEqual(['r1', 'r2']);
  });

  it('marks runs interrupted by a crash as aborted', async () => {
    await store.beginRun(makeRun('r9', 'running'));

    const reconciled = await store.reconcileActiveRuns();

    expect(reconciled).toHaveLength(1);
    expect((await store.getRun('r9'))?.status).toBe('aborted');
    expect((await store.listRuns()).every((entry) => entry.status !== 'running')).toBe(true);
  });
});
