import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes JSON through a temp file and an atomic rename, so a crash mid-write
 * can never leave a half-written test on disk.
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));

  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  try {
    await fs.writeFile(temp, payload, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }

    throw new Error(`Could not read ${file}: ${(error as Error).message}`);
  }
}

/**
 * Reads and validates a stored record. Invalid files are reported with the file
 * path so a hand-edited JSON error is easy to track down.
 */
export async function readValidated<S extends z.ZodType>(
  file: string,
  schema: S,
): Promise<z.infer<S> | undefined> {
  const raw = await readJsonFile<unknown>(file);

  if (raw === undefined) {
    return undefined;
  }

  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`${file} does not match the expected format:\n${detail}`);
  }

  return parsed.data;
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }

    throw error;
  }
}

export async function appendLine(file: string, line: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, `${line}\n`, 'utf8');
}

export async function readLines(file: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw.split('\n').filter((line) => line.trim().length > 0);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }

    throw error;
  }
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Stable hash of a record's meaningful content, used to detect real edits. */
export function contentHash(value: unknown): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex');
}

/** JSON.stringify with sorted object keys so hashing is order-independent. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${entries.join(',')}}`;
}
