import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { ProjectStore, Schedule, TestCase } from '@flowcase/core';
import {
  EnvironmentSchema,
  ProjectConfigSchema,
  STEP_CATALOG,
  STEP_GROUPS,
  ScheduleSchema,
  SnippetSchema,
  TestCaseSchema,
  createEnvironment,
  createSnippet,
  createTest,
  detectCycles,
  dependentsOf,
  diffTests,
  exportToPlaywright,
  newId,
  nextRun,
  nowIso,
  parseCron,
  planRun,
  validateSnippet,
  validateTest,
} from '@flowcase/core';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { EventHub } from './events.js';
import { RecorderManager } from './recorder-manager.js';
import { RunManager } from './run-manager.js';

export interface BuildServerOptions {
  store: ProjectStore;
  /** Directory holding the built React app. Omitted when running Vite separately. */
  uiDir?: string;
  logger?: boolean;
}

export interface FlowcaseServer {
  app: FastifyInstance;
  hub: EventHub;
  runs: RunManager;
  recorder: RecorderManager;
}

/** Reports a bad request as a clean JSON error rather than a stack trace. */
class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function buildServer(options: BuildServerOptions): Promise<FlowcaseServer> {
  const { store } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  const hub = new EventHub();
  const runs = new RunManager(store, hub);
  const recorder = new RecorderManager(store, hub);

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error instanceof HttpError ? error.statusCode : (error.statusCode ?? 500);
    void reply.status(statusCode).send({ error: error.message });
  });

  // ── Live event stream ────────────────────────────────────────────────────
  app.get('/ws', { websocket: true }, (socket) => {
    const send = (event: unknown): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    };

    // Bring a newly connected dashboard up to date immediately.
    send({ type: 'snapshot', activeRuns: runs.activeRuns, recording: recorder.isRecording });

    const unsubscribe = hub.add(send);
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });

  // ── Meta ─────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true, projectDir: store.root }));

  /** The step catalog drives the whole no-code editor, so the UI fetches it once. */
  app.get('/api/catalog', async () => ({
    steps: Object.values(STEP_CATALOG),
    groups: STEP_GROUPS,
  }));

  app.get('/api/config', async () => store.getConfig());

  app.put('/api/config', async (request) => {
    const current = await store.getConfig();
    const parsed = ProjectConfigSchema.safeParse({ ...current, ...(request.body as object) });

    if (!parsed.success) {
      throw new HttpError(400, formatZod(parsed.error.issues));
    }

    return store.saveConfig(parsed.data);
  });

  // ── Tests ────────────────────────────────────────────────────────────────
  app.get('/api/tests', async () => {
    const [tests, snippets] = await Promise.all([store.listTests(), store.listSnippets()]);
    const snippetIds = new Set(snippets.map((snippet) => snippet.id));

    return {
      tests: tests.map((test) => ({
        ...test,
        issues: validateTest(test, { snippetIds }),
      })),
      cycles: detectCycles(tests),
      tags: [...new Set(tests.flatMap((test) => test.tags))].sort(),
    };
  });

  app.post('/api/tests', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<TestCase>;
    const test = createTest(body);
    const saved = await store.saveTest(test);

    void reply.status(201);
    return saved;
  });

  app.get<{ Params: { id: string } }>('/api/tests/:id', async (request) => {
    const test = await store.getTest(request.params.id);

    if (!test) {
      throw new HttpError(404, 'That test no longer exists.');
    }

    const snippets = await store.listSnippets();

    return { ...test, issues: validateTest(test, { snippetIds: new Set(snippets.map((s) => s.id)) }) };
  });

  app.put<{ Params: { id: string } }>('/api/tests/:id', async (request) => {
    const existing = await store.getTest(request.params.id);

    if (!existing) {
      throw new HttpError(404, 'That test no longer exists.');
    }

    const parsed = TestCaseSchema.safeParse({ ...existing, ...(request.body as object), id: existing.id });

    if (!parsed.success) {
      throw new HttpError(400, formatZod(parsed.error.issues));
    }

    return store.saveTest(parsed.data);
  });

  app.delete<{ Params: { id: string } }>('/api/tests/:id', async (request) => {
    await store.deleteTest(request.params.id);
    return { deleted: true };
  });

  app.post<{ Params: { id: string } }>('/api/tests/:id/duplicate', async (request) => {
    const source = await store.getTest(request.params.id);

    if (!source) {
      throw new HttpError(404, 'That test no longer exists.');
    }

    const copy = createTest({
      ...source,
      id: undefined,
      name: `${source.name} (copy)`,
      version: 1,
      status: 'draft',
      approval: { state: 'none' },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    return store.saveTest(copy);
  });

  app.get<{ Params: { id: string } }>('/api/tests/:id/versions', async (request) => {
    const versions = await store.listTestVersions(request.params.id);
    return { versions };
  });

  app.get<{ Params: { id: string; version: string } }>(
    '/api/tests/:id/versions/:version',
    async (request) => {
      const version = await store.getTestVersion(request.params.id, Number(request.params.version));

      if (!version) {
        throw new HttpError(404, 'That version was not kept.');
      }

      return version;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/api/tests/:id/diff',
    async (request) => {
      const versions = await store.listTestVersions(request.params.id);
      const latest = versions[0];
      const toVersion = Number(request.query.to ?? latest ?? 1);
      const fromVersion = Number(request.query.from ?? Math.max(1, toVersion - 1));

      const [before, after] = await Promise.all([
        store.getTestVersion(request.params.id, fromVersion),
        store.getTestVersion(request.params.id, toVersion),
      ]);

      if (!before || !after) {
        throw new HttpError(404, 'One of those versions was not kept.');
      }

      return { from: fromVersion, to: toVersion, diff: diffTests(before, after) };
    },
  );

  app.post<{ Params: { id: string } }>('/api/tests/:id/approval', async (request) => {
    const body = (request.body ?? {}) as { action?: string; user?: string; comment?: string };
    const test = await store.getTest(request.params.id);

    if (!test) {
      throw new HttpError(404, 'That test no longer exists.');
    }

    const timestamp = nowIso();
    let next: TestCase;

    switch (body.action) {
      case 'request':
        next = {
          ...test,
          status: 'in_review',
          approval: {
            ...test.approval,
            state: 'pending',
            ...(body.user === undefined ? {} : { requestedBy: body.user }),
            requestedAt: timestamp,
            ...(body.comment === undefined ? {} : { comment: body.comment }),
          },
        };
        break;

      case 'approve':
        next = {
          ...test,
          status: 'approved',
          approval: {
            ...test.approval,
            state: 'approved',
            ...(body.user === undefined ? {} : { reviewedBy: body.user }),
            reviewedAt: timestamp,
            approvedVersion: test.version,
            ...(body.comment === undefined ? {} : { comment: body.comment }),
          },
        };
        break;

      case 'reject':
        next = {
          ...test,
          status: 'draft',
          approval: {
            ...test.approval,
            state: 'rejected',
            ...(body.user === undefined ? {} : { reviewedBy: body.user }),
            reviewedAt: timestamp,
            ...(body.comment === undefined ? {} : { comment: body.comment }),
          },
        };
        break;

      default:
        throw new HttpError(400, 'Choose one of: request, approve, reject.');
    }

    // Approval is metadata, not a content edit — it must not bump the version.
    return store.saveTest(next, { skipVersioning: true });
  });

  app.get<{ Params: { id: string } }>('/api/tests/:id/dependents', async (request) => {
    const tests = await store.listTests();
    const ids = dependentsOf(tests, request.params.id);

    return { dependents: tests.filter((test) => ids.includes(test.id)).map((t) => ({ id: t.id, name: t.name })) };
  });

  /** Renders a test as a standalone Playwright spec the team can keep as code. */
  app.get<{ Params: { id: string } }>('/api/tests/:id/export', async (request) => {
    const test = await store.getTest(request.params.id);

    if (!test) {
      throw new HttpError(404, 'That test no longer exists.');
    }

    const [snippets, environment] = await Promise.all([
      store.listSnippets(),
      test.environmentId ? store.getEnvironment(test.environmentId) : store.getDefaultEnvironment(),
    ]);

    const code = exportToPlaywright(test, {
      snippets: new Map(snippets.map((snippet) => [snippet.id, snippet])),
      environment,
    });

    return { filename: `${test.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.spec.ts`, code };
  });

  // ── Schedules ────────────────────────────────────────────────────────────
  app.get('/api/schedules', async () => {
    const schedules = await store.listSchedules();

    return {
      schedules: schedules.map((schedule) => ({
        ...schedule,
        nextRunAt: safeNextRun(schedule.cron),
      })),
    };
  });

  app.post('/api/schedules', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<Schedule>;
    const timestamp = nowIso();

    const parsed = ScheduleSchema.safeParse({
      id: newId('sch'),
      name: 'Nightly run',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...body,
    });

    if (!parsed.success) {
      throw new HttpError(400, formatZod(parsed.error.issues));
    }

    void reply.status(201);
    return store.saveSchedule(parsed.data);
  });

  app.put<{ Params: { id: string } }>('/api/schedules/:id', async (request) => {
    const existing = await store.getSchedule(request.params.id);

    if (!existing) {
      throw new HttpError(404, 'That schedule no longer exists.');
    }

    const parsed = ScheduleSchema.safeParse({ ...existing, ...(request.body as object), id: existing.id });

    if (!parsed.success) {
      throw new HttpError(400, formatZod(parsed.error.issues));
    }

    // Reject a bad cron here rather than letting the scheduler silently skip it.
    try {
      parseCron(parsed.data.cron);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid schedule.');
    }

    return store.saveSchedule(parsed.data);
  });

  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (request) => {
    await store.deleteSchedule(request.params.id);
    return { deleted: true };
  });

  app.post<{ Params: { id: string } }>('/api/schedules/:id/run', async (request) => {
    const schedule = await store.getSchedule(request.params.id);

    if (!schedule) {
      throw new HttpError(404, 'That schedule no longer exists.');
    }

    const runId = await runs.start({
      testIds: schedule.testIds,
      tags: schedule.tags,
      ...(schedule.environmentId === undefined ? {} : { environmentId: schedule.environmentId }),
      concurrency: schedule.concurrency,
      approvedOnly: schedule.approvedOnly,
    });

    return { runId };
  });

  // ── Snippets ─────────────────────────────────────────────────────────────
  app.get('/api/snippets', async () => {
    const snippets = await store.listSnippets();
    return { snippets: snippets.map((snippet) => ({ ...snippet, issues: validateSnippet(snippet) })) };
  });

  app.post('/api/snippets', async (request, reply) => {
    const snippet = createSnippet((request.body ?? {}) as object);
    void reply.status(201);
    return store.saveSnippet(snippet);
  });

  app.get<{ Params: { id: string } }>('/api/snippets/:id', async (request) => {
    const snippet = await store.getSnippet(request.params.id);

    if (!snippet) {
      throw new HttpError(404, 'That snippet no longer exists.');
    }

    return snippet;
  });

  app.put<{ Params: { id: string } }>('/api/snippets/:id', async (request) => {
    const existing = await store.getSnippet(request.params.id);

    if (!existing) {
      throw new HttpError(404, 'That snippet no longer exists.');
    }

    const parsed = SnippetSchema.safeParse({ ...existing, ...(request.body as object), id: existing.id });

    if (!parsed.success) {
      throw new HttpError(400, formatZod(parsed.error.issues));
    }

    return store.saveSnippet(parsed.data);
  });

  app.delete<{ Params: { id: string } }>('/api/snippets/:id', async (request) => {
    await store.deleteSnippet(request.params.id);
    return { deleted: true };
  });

  // ── Environments ─────────────────────────────────────────────────────────
  app.get('/api/environments', async () => ({ environments: await store.listEnvironments() }));

  app.post('/api/environments', async (request, reply) => {
    void reply.status(201);
    return store.saveEnvironment(createEnvironment((request.body ?? {}) as object));
  });

  app.put<{ Params: { id: string } }>('/api/environments/:id', async (request) => {
    const existing = await store.getEnvironment(request.params.id);

    if (!existing) {
      throw new HttpError(404, 'That environment no longer exists.');
    }

    const parsed = EnvironmentSchema.safeParse({ ...existing, ...(request.body as object), id: existing.id });

    if (!parsed.success) {
      throw new HttpError(400, formatZod(parsed.error.issues));
    }

    return store.saveEnvironment(parsed.data);
  });

  app.delete<{ Params: { id: string } }>('/api/environments/:id', async (request) => {
    await store.deleteEnvironment(request.params.id);
    return { deleted: true };
  });

  app.get('/api/sessions', async () => ({ sessions: await store.listSessions() }));

  app.delete<{ Params: { name: string } }>('/api/sessions/:name', async (request) => {
    await store.deleteSession(request.params.name);
    return { deleted: true };
  });

  // ── Runs ─────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: string; offset?: string; status?: string; testId?: string; tag?: string } }>(
    '/api/runs',
    async (request) => {
      const summaries = await store.listRuns({
        limit: Number(request.query.limit ?? 50),
        offset: Number(request.query.offset ?? 0),
        ...(request.query.status === undefined ? {} : { status: request.query.status as never }),
        ...(request.query.testId === undefined ? {} : { testId: request.query.testId }),
        ...(request.query.tag === undefined ? {} : { tag: request.query.tag }),
      });

      return { runs: summaries, active: runs.activeRuns };
    },
  );

  app.get('/api/runs/active', async () => ({ active: runs.activeRuns }));

  app.post('/api/runs', async (request, reply) => {
    const runId = await runs.start((request.body ?? {}) as object);
    void reply.status(202);
    return { runId };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    const run = await store.getRun(request.params.id);

    if (!run) {
      throw new HttpError(404, 'That run is no longer on disk — it may have been pruned.');
    }

    return { ...run, active: runs.isActive(run.id) };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/abort', async (request) => ({
    aborted: runs.abort(request.params.id),
  }));

  /** Preview which tests a selection would run, and in what order. */
  app.post('/api/plan', async (request) => {
    const body = (request.body ?? {}) as { testIds?: string[]; tags?: string[]; approvedOnly?: boolean };
    const tests = await store.listTests();

    const plan = planRun({
      tests,
      ...(body.testIds === undefined ? {} : { requestedIds: body.testIds }),
      ...(body.tags === undefined ? {} : { tags: body.tags }),
      ...(body.approvedOnly === undefined ? {} : { approvedOnly: body.approvedOnly }),
    });

    const byId = new Map(tests.map((test) => [test.id, test]));

    return {
      ...plan,
      orderDetail: plan.order.map((id) => ({ id, name: byId.get(id)?.name ?? id })),
    };
  });

  // ── Recorder ─────────────────────────────────────────────────────────────
  app.get('/api/recorder/status', async () => recorder.status());

  app.post('/api/recorder/start', async (request) => recorder.start((request.body ?? {}) as object));

  app.post('/api/recorder/mode', async (request) => {
    const body = (request.body ?? {}) as { mode?: 'record' | 'paused' | 'assert' };
    return recorder.setMode(body.mode ?? 'record');
  });

  app.post('/api/recorder/stop', async () => ({ steps: await recorder.stop() }));

  // ── Artifacts ────────────────────────────────────────────────────────────
  await app.register(fastifyStatic, {
    root: store.runsDir,
    prefix: '/artifacts/',
    decorateReply: true,
  });

  // ── Single-page app ──────────────────────────────────────────────────────
  if (options.uiDir) {
    await app.register(fastifyStatic, {
      root: options.uiDir,
      prefix: '/',
      decorateReply: false,
    });

    // Client-side routes must fall through to index.html; API paths must not.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/artifacts')) {
        void reply.status(404).send({ error: 'Not found' });
        return;
      }

      void reply.sendFile('index.html', options.uiDir);
    });
  }

  return { app, hub, runs, recorder };
}

function formatZod(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || 'value'}: ${issue.message}`)
    .join('; ');
}

export function resolveUiDir(uiDir: string | undefined): string | undefined {
  return uiDir === undefined ? undefined : path.resolve(uiDir);
}

/** Next fire time, or undefined when the expression is invalid or never fires. */
function safeNextRun(cron: string): string | undefined {
  try {
    return nextRun(cron)?.toISOString();
  } catch {
    return undefined;
  }
}
