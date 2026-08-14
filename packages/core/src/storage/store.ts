import path from 'node:path';
import fs from 'node:fs/promises';
import { nowIso, slugify } from '../model/common.js';
import { createEnvironment, createProjectConfig } from '../model/factory.js';
import type { Run, RunStatus, RunSummary } from '../model/run.js';
import { RunSchema, RunSummarySchema, summarizeRun } from '../model/run.js';
import type { Environment, ProjectConfig, Snippet, TestCase } from '../model/test.js';
import { EnvironmentSchema, ProjectConfigSchema, SnippetSchema, TestCaseSchema } from '../model/test.js';
import type { Schedule } from '../schedule/model.js';
import { ScheduleSchema } from '../schedule/model.js';
import {
  appendLine,
  contentHash,
  ensureDir,
  listJsonFiles,
  pathExists,
  readJsonFile,
  readLines,
  readValidated,
  removeDir,
  writeJsonAtomic,
} from './fs-utils.js';

export const PROJECT_DIR_NAME = '.flowcase';

export interface ListRunsOptions {
  limit?: number;
  offset?: number;
  status?: RunStatus;
  testId?: string;
  tag?: string;
}

export interface SaveOptions {
  author?: string;
  /** Skip the version bump — used when only approval metadata changes. */
  skipVersioning?: boolean;
}

/**
 * File-backed project storage. Everything lives under a `.flowcase` directory:
 *
 * ```
 * .flowcase/
 *   flowcase.json          project config
 *   tests/<slug>.json      test definitions (readable git diffs)
 *   snippets/<slug>.json   reusable fragments
 *   environments/<slug>.json
 *   history/<testId>/v<n>.json   every superseded version, for the diff view
 *   runs/index.ndjson      append-only summaries of finished runs
 *   runs/active.json       in-flight runs, so the dashboard sees them immediately
 *   runs/<runId>/          run.json plus screenshots, video, trace, logs
 *   baselines/<testId>/    approved screenshots for visual regression
 *   sessions/<name>.json   saved storage state for auth reuse
 * ```
 */
export class ProjectStore {
  private constructor(readonly root: string) {}

  /** Opens an existing project, walking up from `cwd` like git does. */
  static async open(cwd: string = process.cwd()): Promise<ProjectStore> {
    const root = await ProjectStore.locate(cwd);

    if (!root) {
      throw new Error(
        `No flowcase project found in "${cwd}" or any parent directory. Run \`flowcase init\` first.`,
      );
    }

    return new ProjectStore(root);
  }

  /** Opens a project at an exact directory without searching parents. */
  static at(projectDir: string): ProjectStore {
    return new ProjectStore(projectDir);
  }

  static async locate(cwd: string): Promise<string | undefined> {
    let current = path.resolve(cwd);

    for (;;) {
      const candidate = path.join(current, PROJECT_DIR_NAME);

      if (await pathExists(path.join(candidate, 'flowcase.json'))) {
        return candidate;
      }

      const parent = path.dirname(current);

      if (parent === current) {
        return undefined;
      }

      current = parent;
    }
  }

  /** Creates the directory layout and a starter environment. */
  static async init(cwd: string, options: { name?: string; baseUrl?: string } = {}): Promise<ProjectStore> {
    const root = path.join(path.resolve(cwd), PROJECT_DIR_NAME);
    const store = new ProjectStore(root);

    await Promise.all(
      [
        'tests',
        'snippets',
        'environments',
        'history',
        'runs',
        'baselines',
        'sessions',
        'fixtures',
        'schedules',
      ].map((dir) => ensureDir(path.join(root, dir))),
    );

    if (!(await pathExists(store.configPath))) {
      const environment = createEnvironment({
        name: 'local',
        baseUrl: options.baseUrl ?? '',
        isDefault: true,
      });

      await store.saveEnvironment(environment);
      await store.saveConfig(
        createProjectConfig({
          ...(options.name === undefined ? {} : { name: options.name }),
          defaultEnvironmentId: environment.id,
        }),
      );
    }

    return store;
  }

  // ── Paths ────────────────────────────────────────────────────────────────

  get configPath(): string {
    return path.join(this.root, 'flowcase.json');
  }

  get testsDir(): string {
    return path.join(this.root, 'tests');
  }

  get snippetsDir(): string {
    return path.join(this.root, 'snippets');
  }

  get environmentsDir(): string {
    return path.join(this.root, 'environments');
  }

  get runsDir(): string {
    return path.join(this.root, 'runs');
  }

  get historyDir(): string {
    return path.join(this.root, 'history');
  }

  get baselinesDir(): string {
    return path.join(this.root, 'baselines');
  }

  get sessionsDir(): string {
    return path.join(this.root, 'sessions');
  }

  get schedulesDir(): string {
    return path.join(this.root, 'schedules');
  }

  get fixturesDir(): string {
    return path.join(this.root, 'fixtures');
  }

  get runIndexPath(): string {
    return path.join(this.runsDir, 'index.ndjson');
  }

  get activeRunsPath(): string {
    return path.join(this.runsDir, 'active.json');
  }

  runDir(runId: string): string {
    return path.join(this.runsDir, runId);
  }

  sessionPath(name: string): string {
    return path.join(this.sessionsDir, `${slugify(name)}.json`);
  }

  baselinePath(testId: string, name: string): string {
    return path.join(this.baselinesDir, testId, `${slugify(name)}.png`);
  }

  // ── Config ───────────────────────────────────────────────────────────────

  async getConfig(): Promise<ProjectConfig> {
    const config = await readValidated(this.configPath, ProjectConfigSchema);
    return config ?? createProjectConfig();
  }

  async saveConfig(config: ProjectConfig): Promise<ProjectConfig> {
    const next = { ...config, updatedAt: nowIso() };
    await writeJsonAtomic(this.configPath, next);
    return next;
  }

  // ── Tests ────────────────────────────────────────────────────────────────

  async listTests(): Promise<TestCase[]> {
    const files = await listJsonFiles(this.testsDir);
    const tests = await Promise.all(files.map((file) => readValidated(file, TestCaseSchema)));

    return tests
      .filter((test): test is TestCase => test !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getTest(id: string): Promise<TestCase | undefined> {
    const file = await this.findFileById(this.testsDir, id);
    return file ? readValidated(file, TestCaseSchema) : undefined;
  }

  /**
   * Persists a test. When the meaningful content changed, the previous version is
   * archived under `history/` and the version number is bumped — that history is
   * what the diff view reads. A content change also invalidates any existing
   * approval, so an approved test cannot be silently edited.
   */
  async saveTest(test: TestCase, options: SaveOptions = {}): Promise<TestCase> {
    const existingFile = await this.findFileById(this.testsDir, test.id);
    const existing = existingFile ? await readValidated(existingFile, TestCaseSchema) : undefined;

    let next: TestCase = { ...test, updatedAt: nowIso() };

    if (options.author) {
      next.updatedBy = options.author;
    }

    if (existing && !options.skipVersioning) {
      const changed = contentHash(comparableTest(existing)) !== contentHash(comparableTest(next));

      if (changed) {
        await this.archiveTestVersion(existing);
        next.version = existing.version + 1;

        if (existing.status === 'approved') {
          next.status = 'draft';
          next.approval = { ...next.approval, state: 'none' };
        }
      } else {
        next.version = existing.version;
      }
    }

    next = TestCaseSchema.parse(next);

    const targetFile = await this.uniqueFilePath(this.testsDir, next.name, next.id);
    await writeJsonAtomic(targetFile, next);

    if (existingFile && existingFile !== targetFile) {
      await fs.rm(existingFile, { force: true });
    }

    return next;
  }

  async deleteTest(id: string): Promise<void> {
    const file = await this.findFileById(this.testsDir, id);

    if (file) {
      await fs.rm(file, { force: true });
    }

    await removeDir(path.join(this.historyDir, id));
  }

  private async archiveTestVersion(test: TestCase): Promise<void> {
    const file = path.join(this.historyDir, test.id, `v${test.version}.json`);
    await writeJsonAtomic(file, test);
  }

  /** Version numbers available for the diff view, newest first. */
  async listTestVersions(testId: string): Promise<number[]> {
    const current = await this.getTest(testId);
    const files = await listJsonFiles(path.join(this.historyDir, testId));

    const archived = files
      .map((file) => Number.parseInt(path.basename(file).replace(/^v|\.json$/g, ''), 10))
      .filter((value) => Number.isFinite(value));

    const all = current ? [...archived, current.version] : archived;

    return [...new Set(all)].sort((a, b) => b - a);
  }

  async getTestVersion(testId: string, version: number): Promise<TestCase | undefined> {
    const current = await this.getTest(testId);

    if (current && current.version === version) {
      return current;
    }

    return readValidated(path.join(this.historyDir, testId, `v${version}.json`), TestCaseSchema);
  }

  // ── Snippets ─────────────────────────────────────────────────────────────

  async listSnippets(): Promise<Snippet[]> {
    const files = await listJsonFiles(this.snippetsDir);
    const snippets = await Promise.all(files.map((file) => readValidated(file, SnippetSchema)));

    return snippets
      .filter((snippet): snippet is Snippet => snippet !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSnippet(id: string): Promise<Snippet | undefined> {
    const file = await this.findFileById(this.snippetsDir, id);
    return file ? readValidated(file, SnippetSchema) : undefined;
  }

  async saveSnippet(snippet: Snippet): Promise<Snippet> {
    const existingFile = await this.findFileById(this.snippetsDir, snippet.id);
    const existing = existingFile ? await readValidated(existingFile, SnippetSchema) : undefined;

    let next: Snippet = { ...snippet, updatedAt: nowIso() };

    if (existing && contentHash(comparableSnippet(existing)) !== contentHash(comparableSnippet(next))) {
      next.version = existing.version + 1;
    } else if (existing) {
      next.version = existing.version;
    }

    next = SnippetSchema.parse(next);

    const targetFile = await this.uniqueFilePath(this.snippetsDir, next.name, next.id);
    await writeJsonAtomic(targetFile, next);

    if (existingFile && existingFile !== targetFile) {
      await fs.rm(existingFile, { force: true });
    }

    return next;
  }

  async deleteSnippet(id: string): Promise<void> {
    const file = await this.findFileById(this.snippetsDir, id);

    if (file) {
      await fs.rm(file, { force: true });
    }
  }

  // ── Environments ─────────────────────────────────────────────────────────

  async listEnvironments(): Promise<Environment[]> {
    const files = await listJsonFiles(this.environmentsDir);
    const environments = await Promise.all(files.map((file) => readValidated(file, EnvironmentSchema)));

    return environments
      .filter((environment): environment is Environment => environment !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getEnvironment(id: string): Promise<Environment | undefined> {
    const file = await this.findFileById(this.environmentsDir, id);
    return file ? readValidated(file, EnvironmentSchema) : undefined;
  }

  /** The run-time default: explicit project setting, else the flagged one, else the first. */
  async getDefaultEnvironment(): Promise<Environment | undefined> {
    const config = await this.getConfig();

    if (config.defaultEnvironmentId) {
      const preferred = await this.getEnvironment(config.defaultEnvironmentId);

      if (preferred) {
        return preferred;
      }
    }

    const all = await this.listEnvironments();

    return all.find((environment) => environment.isDefault) ?? all[0];
  }

  async saveEnvironment(environment: Environment): Promise<Environment> {
    const existingFile = await this.findFileById(this.environmentsDir, environment.id);
    const next = EnvironmentSchema.parse({ ...environment, updatedAt: nowIso() });

    const targetFile = await this.uniqueFilePath(this.environmentsDir, next.name, next.id);
    await writeJsonAtomic(targetFile, next);

    if (existingFile && existingFile !== targetFile) {
      await fs.rm(existingFile, { force: true });
    }

    return next;
  }

  async deleteEnvironment(id: string): Promise<void> {
    const file = await this.findFileById(this.environmentsDir, id);

    if (file) {
      await fs.rm(file, { force: true });
    }
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  /** Registers a run as in-flight and creates its artifact directory. */
  async beginRun(run: Run): Promise<void> {
    await ensureDir(this.runDir(run.id));
    await this.writeRunFile(run);
    await this.upsertActiveRun(summarizeRun(run));
  }

  /** Persists the current state of a running test. Safe to call frequently. */
  async updateRun(run: Run): Promise<void> {
    await this.writeRunFile(run);
    await this.upsertActiveRun(summarizeRun(run));
  }

  /** Moves the run out of the active list and into the append-only index. */
  async completeRun(run: Run, tags: string[] = []): Promise<void> {
    await this.writeRunFile(run);

    const summary: RunSummary = { ...summarizeRun(run), tags };
    await appendLine(this.runIndexPath, JSON.stringify(summary));
    await this.removeActiveRun(run.id);

    const config = await this.getConfig();
    await this.pruneRuns(config.runRetention);
  }

  async getRun(runId: string): Promise<Run | undefined> {
    return readValidated(path.join(this.runDir(runId), 'run.json'), RunSchema);
  }

  /**
   * Lists runs newest-first. Reads only the NDJSON index plus the small active
   * list, so history stays fast without a database.
   */
  async listRuns(options: ListRunsOptions = {}): Promise<RunSummary[]> {
    const { limit = 50, offset = 0 } = options;

    const finished = (await readLines(this.runIndexPath))
      .map((line) => safeParseSummary(line))
      .filter((summary): summary is RunSummary => summary !== undefined);

    const active = await this.readActiveRuns();
    const activeIds = new Set(active.map((summary) => summary.id));

    const all = [...active, ...finished.filter((summary) => !activeIds.has(summary.id))].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );

    const filtered = all.filter((summary) => {
      if (options.status && summary.status !== options.status) {
        return false;
      }

      if (options.testId && !summary.testIds.includes(options.testId)) {
        return false;
      }

      if (options.tag && !summary.tags.includes(options.tag)) {
        return false;
      }

      return true;
    });

    return filtered.slice(offset, offset + limit);
  }

  /** Marks orphaned in-flight runs as aborted — called at server startup after a crash. */
  async reconcileActiveRuns(): Promise<RunSummary[]> {
    const active = await this.readActiveRuns();

    if (active.length === 0) {
      return [];
    }

    const reconciled: RunSummary[] = [];

    for (const summary of active) {
      const run = await this.getRun(summary.id);

      if (run && (run.status === 'running' || run.status === 'queued')) {
        const aborted: Run = {
          ...run,
          status: 'aborted',
          finishedAt: nowIso(),
          error: 'Run was interrupted — the flowcase process stopped before it finished.',
        };

        await this.writeRunFile(aborted);
        await appendLine(this.runIndexPath, JSON.stringify({ ...summarizeRun(aborted), tags: summary.tags }));
        reconciled.push(summarizeRun(aborted));
      }
    }

    await writeJsonAtomic(this.activeRunsPath, []);

    return reconciled;
  }

  /** Keeps the newest `retention` runs and deletes the rest, index included. */
  async pruneRuns(retention: number): Promise<number> {
    const lines = await readLines(this.runIndexPath);
    const summaries = lines
      .map((line) => safeParseSummary(line))
      .filter((summary): summary is RunSummary => summary !== undefined);

    if (summaries.length <= retention) {
      return 0;
    }

    const sorted = [...summaries].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const keep = sorted.slice(0, retention);
    const drop = sorted.slice(retention);

    await Promise.all(drop.map((summary) => removeDir(this.runDir(summary.id))));

    const rewritten = keep
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((summary) => JSON.stringify(summary))
      .join('\n');

    await fs.writeFile(this.runIndexPath, rewritten.length > 0 ? `${rewritten}\n` : '', 'utf8');

    return drop.length;
  }

  private async writeRunFile(run: Run): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(run.id), 'run.json'), run);
  }

  private async readActiveRuns(): Promise<RunSummary[]> {
    const raw = await readValidated(this.activeRunsPath, RunSummarySchema.array());
    return raw ?? [];
  }

  private async upsertActiveRun(summary: RunSummary): Promise<void> {
    const active = await this.readActiveRuns();
    const next = active.filter((entry) => entry.id !== summary.id);
    next.push(summary);
    await writeJsonAtomic(this.activeRunsPath, next);
  }

  private async removeActiveRun(runId: string): Promise<void> {
    const active = await this.readActiveRuns();
    await writeJsonAtomic(
      this.activeRunsPath,
      active.filter((entry) => entry.id !== runId),
    );
  }

  // ── Schedules ────────────────────────────────────────────────────────────

  async listSchedules(): Promise<Schedule[]> {
    const files = await listJsonFiles(this.schedulesDir);
    const schedules = await Promise.all(files.map((file) => readValidated(file, ScheduleSchema)));

    return schedules
      .filter((schedule): schedule is Schedule => schedule !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSchedule(id: string): Promise<Schedule | undefined> {
    const file = await this.findFileById(this.schedulesDir, id);
    return file ? readValidated(file, ScheduleSchema) : undefined;
  }

  async saveSchedule(schedule: Schedule): Promise<Schedule> {
    const existingFile = await this.findFileById(this.schedulesDir, schedule.id);
    const next = ScheduleSchema.parse({ ...schedule, updatedAt: nowIso() });

    const targetFile = await this.uniqueFilePath(this.schedulesDir, next.name, next.id);
    await writeJsonAtomic(targetFile, next);

    if (existingFile && existingFile !== targetFile) {
      await fs.rm(existingFile, { force: true });
    }

    return next;
  }

  async deleteSchedule(id: string): Promise<void> {
    const file = await this.findFileById(this.schedulesDir, id);

    if (file) {
      await fs.rm(file, { force: true });
    }
  }

  // ── Sessions (auth reuse) ────────────────────────────────────────────────

  async listSessions(): Promise<string[]> {
    const files = await listJsonFiles(this.sessionsDir);
    return files.map((file) => path.basename(file, '.json'));
  }

  async deleteSession(name: string): Promise<void> {
    await fs.rm(this.sessionPath(name), { force: true });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Records are stored under readable slugs rather than ids, so a git diff shows
   * which test changed. That means finding a record by id requires a scan — cheap
   * for the file counts involved, and the readability is worth it.
   */
  private async findFileById(dir: string, id: string): Promise<string | undefined> {
    const files = await listJsonFiles(dir);

    for (const file of files) {
      const record = await readJsonFile<{ id?: string }>(file);

      if (record?.id === id) {
        return file;
      }
    }

    return undefined;
  }

  /** `name.json`, or `name-2.json` when a different record already owns that slug. */
  private async uniqueFilePath(dir: string, name: string, id: string): Promise<string> {
    const base = slugify(name);

    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const candidate = path.join(dir, suffix === 1 ? `${base}.json` : `${base}-${suffix}.json`);

      if (!(await pathExists(candidate))) {
        return candidate;
      }

      const owner = await readJsonFile<{ id?: string }>(candidate);

      if (owner?.id === id) {
        return candidate;
      }
    }

    return path.join(dir, `${base}-${id}.json`);
  }
}

function safeParseSummary(line: string): RunSummary | undefined {
  try {
    const parsed = RunSummarySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The fields that constitute a real edit — metadata is deliberately excluded. */
function comparableTest(test: TestCase): unknown {
  const { updatedAt, createdAt, version, approval, status, updatedBy, createdBy, ...rest } = test;
  return rest;
}

function comparableSnippet(snippet: Snippet): unknown {
  const { updatedAt, createdAt, version, ...rest } = snippet;
  return rest;
}
