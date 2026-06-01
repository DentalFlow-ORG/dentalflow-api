export const BRAZIL_TIME_ZONE = 'America/Sao_Paulo';

// Brazil is UTC-3 year-round since DST was abolished in 2019.
const BRAZIL_UTC_OFFSET_HOURS = 3;

function brazilDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BRAZIL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  return {
    year: Number(parts.find((p) => p.type === 'year')!.value),
    month: Number(parts.find((p) => p.type === 'month')!.value),
    day: Number(parts.find((p) => p.type === 'day')!.value),
  };
}

/** Returns the Brazil calendar date as 'YYYY-MM-DD'. */
export function formatBrazilDateOnly(date: Date): string {
  const { year, month, day } = brazilDateParts(date);
  return [
    String(year),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

/** Returns today's date in Brazil as 'YYYY-MM-DD'. */
export function brazilTodayIso(now = new Date()): string {
  return formatBrazilDateOnly(now);
}

/** Returns the current year-month in Brazil as 'YYYY-MM'. */
export function brazilCurrentIsoMonth(now = new Date()): string {
  const { year, month } = brazilDateParts(now);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Returns the Brazil calendar date string for N days before today.
 * Uses UTC noon to stay well within any single Brazil calendar day.
 */
export function brazilDaysAgoIso(days: number, now = new Date()): string {
  const today = brazilTodayIso(now);
  const [ty, tm, td] = today.split('-').map(Number);
  // UTC noon stays safely in the same Brazil calendar day as the computed date
  return brazilTodayIso(new Date(Date.UTC(ty, tm - 1, td - days, 12, 0, 0)));
}

/**
 * Converts a Brazil calendar date string to UTC timestamp boundaries
 * for filtering TIMESTAMP fields (createdAt, updatedAt).
 *
 * start = Brazil 00:00 of dateString → UTC 03:00 same date
 * end   = Brazil 00:00 of next date  → UTC 03:00 next date (exclusive)
 *
 * Usage: `gte: start, lt: end`
 */
export function parseBrazilDateOnlyToUtcRange(dateString: string): {
  start: Date;
  end: Date;
} {
  const match = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(
      `parseBrazilDateOnlyToUtcRange: invalid date string "${dateString}"`,
    );
  }
  const [, y, m, d] = match.map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, d,     BRAZIL_UTC_OFFSET_HOURS, 0, 0)),
    end:   new Date(Date.UTC(y, m - 1, d + 1, BRAZIL_UTC_OFFSET_HOURS, 0, 0)),
  };
}

/**
 * Returns UTC timestamp boundaries for the current Brazil calendar day.
 * Shorthand for `parseBrazilDateOnlyToUtcRange(brazilTodayIso(now))`.
 *
 * Usage: `gte: start, lt: end`
 */
export function getBrazilDayRange(now = new Date()): { start: Date; end: Date } {
  return parseBrazilDateOnlyToUtcRange(brazilTodayIso(now));
}

/**
 * Returns UTC timestamp boundaries for a Brazil year-month for TIMESTAMP fields.
 *
 * start = first day of month at Brazil midnight → UTC
 * end   = first day of NEXT month at Brazil midnight → UTC (exclusive)
 *
 * Usage: `gte: start, lt: end`
 */
export function getBrazilMonthRange(yearMonth: string): { start: Date; end: Date } {
  const match = yearMonth.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error(`getBrazilMonthRange: invalid year-month "${yearMonth}"`);
  }
  const [, y, m] = match.map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1, BRAZIL_UTC_OFFSET_HOURS, 0, 0)),
    end:   new Date(Date.UTC(y, m,     1, BRAZIL_UTC_OFFSET_HOURS, 0, 0)),
  };
}
