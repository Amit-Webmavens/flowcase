/**
 * A small five-field cron implementation.
 *
 * Written rather than pulled in as a dependency: the syntax flowcase needs is
 * the standard `minute hour day-of-month month day-of-week`, with `*`, ranges,
 * lists and steps. Keeping it in-tree means the package has no scheduling
 * dependency to audit or keep current.
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when the field was `*`, which changes day-of-month/day-of-week logic. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

export class CronSyntaxError extends Error {
  constructor(expression: string, detail: string) {
    super(`"${expression}" is not a valid schedule: ${detail}`);
    this.name = 'CronSyntaxError';
  }
}

const NAMED: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseCron(expression: string): CronFields {
  const normalized = (NAMED[expression.trim().toLowerCase()] ?? expression).trim();
  const parts = normalized.split(/\s+/);

  if (parts.length !== 5) {
    throw new CronSyntaxError(expression, `expected 5 fields but found ${parts.length}`);
  }

  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = parts;

  return {
    minutes: parseField(expression, minute, 0, 59),
    hours: parseField(expression, hour, 0, 23),
    daysOfMonth: parseField(expression, dayOfMonth, 1, 31),
    months: parseField(expression, month, 1, 12, MONTH_NAMES, 1),
    daysOfWeek: normalizeSunday(parseField(expression, dayOfWeek, 0, 7, DAY_NAMES, 0)),
    anyDayOfMonth: dayOfMonth === '*',
    anyDayOfWeek: dayOfWeek === '*',
  };
}

function parseField(
  expression: string,
  field: string,
  min: number,
  max: number,
  names?: string[],
  nameOffset = 0,
): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const [rangePart = '', stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);

    if (!Number.isInteger(step) || step < 1) {
      throw new CronSyntaxError(expression, `"${part}" has an invalid step`);
    }

    let start: number;
    let end: number;

    if (rangePart === '*' || rangePart === '') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [from = '', to = ''] = rangePart.split('-');
      start = toNumber(expression, from, names, nameOffset);
      end = toNumber(expression, to, names, nameOffset);
    } else {
      start = toNumber(expression, rangePart, names, nameOffset);
      end = stepPart === undefined ? start : max;
    }

    if (start < min || end > max || start > end) {
      throw new CronSyntaxError(expression, `"${part}" is outside the allowed range ${min}–${max}`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return values;
}

function toNumber(expression: string, token: string, names: string[] | undefined, offset: number): number {
  const trimmed = token.trim().toLowerCase();

  if (names) {
    const index = names.indexOf(trimmed);

    if (index >= 0) {
      return index + offset;
    }
  }

  const value = Number(trimmed);

  if (!Number.isInteger(value)) {
    throw new CronSyntaxError(expression, `"${token}" is not a number`);
  }

  return value;
}

/** Cron allows both 0 and 7 for Sunday. */
function normalizeSunday(values: Set<number>): Set<number> {
  if (values.has(7)) {
    values.delete(7);
    values.add(0);
  }

  return values;
}

export function matchesCron(fields: CronFields, date: Date): boolean {
  if (!fields.minutes.has(date.getMinutes())) return false;
  if (!fields.hours.has(date.getHours())) return false;
  if (!fields.months.has(date.getMonth() + 1)) return false;

  const dayOfMonthMatches = fields.daysOfMonth.has(date.getDate());
  const dayOfWeekMatches = fields.daysOfWeek.has(date.getDay());

  // Standard cron: when both day fields are restricted, either one matching is enough.
  if (fields.anyDayOfMonth && fields.anyDayOfWeek) {
    return true;
  }

  if (fields.anyDayOfMonth) {
    return dayOfWeekMatches;
  }

  if (fields.anyDayOfWeek) {
    return dayOfMonthMatches;
  }

  return dayOfMonthMatches || dayOfWeekMatches;
}

/**
 * The next time the expression fires strictly after `from`. Scans minute by
 * minute, bounded to four years so an impossible schedule (31 February) returns
 * undefined instead of looping.
 */
export function nextRun(expression: string, from: Date = new Date()): Date | undefined {
  const fields = parseCron(expression);
  const candidate = new Date(from.getTime());

  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = 4 * 366 * 24 * 60;

  for (let step = 0; step < limit; step += 1) {
    if (matchesCron(fields, candidate)) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return undefined;
}

/** Plain-language description used in the UI so testers can sanity-check a schedule. */
export function describeCron(expression: string): string {
  try {
    const next = nextRun(expression);

    return next ? `Next run ${next.toLocaleString()}` : 'This schedule never fires.';
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid schedule.';
  }
}
