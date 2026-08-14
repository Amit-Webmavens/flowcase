import { describe, expect, it } from 'vitest';
import { CronSyntaxError, matchesCron, nextRun, parseCron } from '../src/schedule/cron.js';

const at = (iso: string): Date => new Date(iso);

describe('parseCron', () => {
  it('expands wildcards, lists, ranges and steps', () => {
    const fields = parseCron('0,30 9-17/4 * * 1-5');

    expect([...fields.minutes]).toEqual([0, 30]);
    expect([...fields.hours]).toEqual([9, 13, 17]);
    expect([...fields.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(fields.anyDayOfMonth).toBe(true);
  });

  it('supports shorthand expressions', () => {
    expect([...parseCron('@daily').minutes]).toEqual([0]);
    expect([...parseCron('@daily').hours]).toEqual([0]);
    expect([...parseCron('@hourly').hours]).toHaveLength(24);
  });

  it('accepts month and day names', () => {
    expect([...parseCron('0 0 1 jan *').months]).toEqual([1]);
    expect([...parseCron('0 0 * * mon').daysOfWeek]).toEqual([1]);
  });

  it('treats 7 as Sunday', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('0 0 *')).toThrow(CronSyntaxError);
    expect(() => parseCron('99 0 * * *')).toThrow(CronSyntaxError);
    expect(() => parseCron('0 0 * * abc')).toThrow(CronSyntaxError);
  });
});

describe('matchesCron', () => {
  it('matches an exact time', () => {
    const fields = parseCron('30 3 * * *');

    expect(matchesCron(fields, at('2026-08-14T03:30:00'))).toBe(true);
    expect(matchesCron(fields, at('2026-08-14T03:31:00'))).toBe(false);
    expect(matchesCron(fields, at('2026-08-14T04:30:00'))).toBe(false);
  });

  it('matches a weekday-only schedule', () => {
    const fields = parseCron('0 8 * * 1-5');

    // 2026-08-14 is a Friday; 2026-08-15 a Saturday.
    expect(matchesCron(fields, at('2026-08-14T08:00:00'))).toBe(true);
    expect(matchesCron(fields, at('2026-08-15T08:00:00'))).toBe(false);
  });

  it('uses OR when both day fields are restricted, as cron does', () => {
    const fields = parseCron('0 0 1 * 1');

    // The 1st of the month, whatever day it falls on.
    expect(matchesCron(fields, at('2026-08-01T00:00:00'))).toBe(true);
    // Any Monday, whatever the date.
    expect(matchesCron(fields, at('2026-08-17T00:00:00'))).toBe(true);
    expect(matchesCron(fields, at('2026-08-18T00:00:00'))).toBe(false);
  });

  it('matches every fifteen minutes', () => {
    const fields = parseCron('*/15 * * * *');

    expect(matchesCron(fields, at('2026-08-14T10:00:00'))).toBe(true);
    expect(matchesCron(fields, at('2026-08-14T10:15:00'))).toBe(true);
    expect(matchesCron(fields, at('2026-08-14T10:16:00'))).toBe(false);
  });
});

describe('nextRun', () => {
  it('returns the next matching minute, never the current one', () => {
    const next = nextRun('0 3 * * *', at('2026-08-14T03:00:00'));

    expect(next?.toISOString().slice(0, 16)).toBe(new Date('2026-08-15T03:00:00').toISOString().slice(0, 16));
  });

  it('finds the next slot later the same day', () => {
    const next = nextRun('*/15 * * * *', at('2026-08-14T10:02:00'));

    expect(next?.getMinutes()).toBe(15);
    expect(next?.getHours()).toBe(10);
  });

  it('returns undefined for a schedule that can never fire', () => {
    expect(nextRun('0 0 30 2 *')).toBeUndefined();
  });
});
