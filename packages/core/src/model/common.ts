import { customAlphabet } from 'nanoid';
import { z } from 'zod';

/**
 * Short, URL-safe, human-copyable identifiers. Lowercase alphanumerics only so
 * ids can double as file names on case-insensitive file systems.
 */
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const generate = customAlphabet(alphabet, 12);

export function newId(prefix: string): string {
  return `${prefix}_${generate()}`;
}

/** ISO-8601 timestamp, always UTC. Stored as a plain string so JSON round-trips cleanly. */
export function nowIso(): string {
  return new Date().toISOString();
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** A timestamp field. Kept as a bare string to avoid Date/JSON serialisation drift. */
export const TimestampSchema = z.string();

/**
 * Turns a display name into a stable file-system-safe slug. Used for test and
 * snippet file names so the on-disk layout stays readable in git diffs.
 */
export function slugify(value: string): string {
  // NFKD splits accents into combining marks, which the non-alphanumeric filter
  // below then strips — so "Añadir Pedido" becomes "anadir-pedido".
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return slug.length > 0 ? slug : 'untitled';
}

/** Deep clone that only handles JSON-compatible data — which is all we ever store. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
