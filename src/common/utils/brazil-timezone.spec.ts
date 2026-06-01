import {
  BRAZIL_TIME_ZONE,
  brazilCurrentIsoMonth,
  brazilDaysAgoIso,
  brazilTodayIso,
  formatBrazilDateOnly,
  getBrazilDayRange,
  getBrazilMonthRange,
  parseBrazilDateOnlyToUtcRange,
} from './brazil-timezone';

// Brazil is UTC-3 year-round (DST abolished 2019).
// All fixtures use explicit UTC timestamps so tests pass in any server timezone.
//
// Key boundary:
//   Brazil midnight = UTC 03:00 of the same calendar date
//   At UTC 02:59:59 on June 1 → Brazil is still May 31 23:59:59
//   At UTC 03:00:00 on June 1 → Brazil is now June 1 00:00:00

describe('BRAZIL_TIME_ZONE', () => {
  it('is America/Sao_Paulo', () => {
    expect(BRAZIL_TIME_ZONE).toBe('America/Sao_Paulo');
  });
});

describe('formatBrazilDateOnly', () => {
  it('returns YYYY-MM-DD in Brazil timezone, not UTC', () => {
    // 2026-06-01 01:00 UTC → May 31 22:00 Brazil → Brazil date is May 31
    expect(formatBrazilDateOnly(new Date('2026-06-01T01:00:00Z'))).toBe('2026-05-31');
  });

  it('returns the correct Brazil date during the day', () => {
    expect(formatBrazilDateOnly(new Date('2026-06-15T12:00:00Z'))).toBe('2026-06-15');
  });

  it('transitions to the new Brazil day at UTC 03:00', () => {
    // 2026-06-01 02:59 UTC → still May 31 Brazil
    expect(formatBrazilDateOnly(new Date('2026-06-01T02:59:59Z'))).toBe('2026-05-31');
    // 2026-06-01 03:00 UTC → Brazil midnight, now June 1
    expect(formatBrazilDateOnly(new Date('2026-06-01T03:00:00Z'))).toBe('2026-06-01');
  });
});

describe('brazilTodayIso', () => {
  it('returns Brazil today, not UTC today, near midnight UTC', () => {
    // Between 00:00-02:59 UTC, UTC date is already "tomorrow" but Brazil is still "today"
    expect(brazilTodayIso(new Date('2026-06-01T02:00:00Z'))).toBe('2026-05-31');
    expect(brazilTodayIso(new Date('2026-06-01T03:00:00Z'))).toBe('2026-06-01');
  });

  it('returns YYYY-MM-DD format', () => {
    expect(brazilTodayIso(new Date('2026-06-15T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('brazilCurrentIsoMonth', () => {
  it('returns YYYY-MM format', () => {
    expect(brazilCurrentIsoMonth(new Date('2026-06-15T12:00:00Z'))).toMatch(/^\d{4}-\d{2}$/);
  });

  it('returns the correct Brazil month near month boundary', () => {
    // 2026-06-01 01:00 UTC → Brazil is still May 31 → month is 2026-05
    expect(brazilCurrentIsoMonth(new Date('2026-06-01T01:00:00Z'))).toBe('2026-05');
    // 2026-06-01 03:00 UTC → Brazil is now June 1 → month is 2026-06
    expect(brazilCurrentIsoMonth(new Date('2026-06-01T03:00:00Z'))).toBe('2026-06');
  });
});

describe('brazilDaysAgoIso', () => {
  it('returns a date N Brazil calendar days before today', () => {
    // Brazil today = 2026-06-30; 30 days ago = 2026-05-31
    const now = new Date('2026-06-30T12:00:00Z');
    expect(brazilDaysAgoIso(30, now)).toBe('2026-05-31');
  });

  it('crosses month boundaries correctly', () => {
    const now = new Date('2026-06-15T12:00:00Z'); // Brazil: 2026-06-15
    expect(brazilDaysAgoIso(20, now)).toBe('2026-05-26');
  });

  it('crosses year boundaries correctly', () => {
    const now = new Date('2026-01-10T12:00:00Z'); // Brazil: 2026-01-10
    expect(brazilDaysAgoIso(15, now)).toBe('2025-12-26');
  });

  it('returns today when days is 0', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(brazilDaysAgoIso(0, now)).toBe('2026-06-15');
  });
});

describe('parseBrazilDateOnlyToUtcRange', () => {
  it('returns Brazil midnight as UTC+3h for start', () => {
    const { start } = parseBrazilDateOnlyToUtcRange('2026-05-31');
    // Brazil midnight May 31 = UTC 03:00 May 31
    expect(start.toISOString()).toBe('2026-05-31T03:00:00.000Z');
  });

  it('returns next Brazil midnight as UTC for end (exclusive)', () => {
    const { end } = parseBrazilDateOnlyToUtcRange('2026-05-31');
    // Next Brazil midnight = June 1 00:00 Brazil = UTC 03:00 June 1
    expect(end.toISOString()).toBe('2026-06-01T03:00:00.000Z');
  });

  it('correctly handles date not shifting to previous day', () => {
    // A record created at 2026-06-01T02:00:00Z is Brazil May 31 23:00.
    // Filtering by dateFrom='2026-06-01' should NOT include it.
    const { start } = parseBrazilDateOnlyToUtcRange('2026-06-01');
    expect(start.toISOString()).toBe('2026-06-01T03:00:00.000Z');
    const createdAt = new Date('2026-06-01T02:00:00Z');
    expect(createdAt >= start).toBe(false); // correctly excluded
  });

  it('includes records from the start of the Brazil day', () => {
    const { start, end } = parseBrazilDateOnlyToUtcRange('2026-06-01');
    // A record at 03:00 UTC = midnight Brazil is within June 1 Brazil
    expect(new Date('2026-06-01T03:00:00Z') >= start).toBe(true);
    expect(new Date('2026-06-01T03:00:00Z') < end).toBe(true);
  });

  it('end is exclusive — records at Brazil midnight next day are excluded', () => {
    const { end } = parseBrazilDateOnlyToUtcRange('2026-06-01');
    // 2026-06-02T03:00:00Z is midnight of June 2 Brazil — should NOT be in June 1 range
    expect(new Date('2026-06-02T03:00:00Z') < end).toBe(false);
  });

  it('handles month overflow (day+1 crossing month boundary)', () => {
    const { start, end } = parseBrazilDateOnlyToUtcRange('2026-05-31');
    expect(start.toISOString()).toBe('2026-05-31T03:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T03:00:00.000Z');
  });

  it('throws for invalid date strings', () => {
    expect(() => parseBrazilDateOnlyToUtcRange('not-a-date')).toThrow();
    expect(() => parseBrazilDateOnlyToUtcRange('2026-6-1')).toThrow();
  });
});

describe('getBrazilDayRange', () => {
  it('returns today Brazil day as UTC timestamps', () => {
    // UTC 02:00 June 1 → Brazil today is May 31
    const { start, end } = getBrazilDayRange(new Date('2026-06-01T02:00:00Z'));
    expect(start.toISOString()).toBe('2026-05-31T03:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T03:00:00.000Z');
  });

  it('returns June 1 range once Brazil day starts at UTC 03:00', () => {
    const { start, end } = getBrazilDayRange(new Date('2026-06-01T03:00:00Z'));
    expect(start.toISOString()).toBe('2026-06-01T03:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-02T03:00:00.000Z');
  });

  it('end is exclusive (gte start, lt end covers exactly one Brazil day)', () => {
    const { start, end } = getBrazilDayRange(new Date('2026-06-15T12:00:00Z'));
    // Duration is exactly 24 hours
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('getBrazilMonthRange', () => {
  it('returns month start and exclusive end in UTC for a Brazil month', () => {
    const { start, end } = getBrazilMonthRange('2026-05');
    // First of May Brazil = May 1 03:00 UTC
    expect(start.toISOString()).toBe('2026-05-01T03:00:00.000Z');
    // First of June Brazil = June 1 03:00 UTC (exclusive end)
    expect(end.toISOString()).toBe('2026-06-01T03:00:00.000Z');
  });

  it('handles December → January year boundary', () => {
    const { start, end } = getBrazilMonthRange('2026-12');
    expect(start.toISOString()).toBe('2026-12-01T03:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T03:00:00.000Z');
  });

  it('includes a record created on the first day of the Brazil month', () => {
    const { start, end } = getBrazilMonthRange('2026-06');
    // Record created at 2026-06-01T03:00:00Z = June 1 00:00 Brazil
    const record = new Date('2026-06-01T03:00:00Z');
    expect(record >= start && record < end).toBe(true);
  });

  it('excludes a record created just before Brazil month start', () => {
    const { start } = getBrazilMonthRange('2026-06');
    // 2026-06-01T02:59:59Z = May 31 23:59 Brazil — not in June
    const record = new Date('2026-06-01T02:59:59Z');
    expect(record >= start).toBe(false);
  });

  it('throws for invalid year-month', () => {
    expect(() => getBrazilMonthRange('2026-6')).toThrow();
    expect(() => getBrazilMonthRange('not-a-month')).toThrow();
  });
});

// ── Payment-date default (regression for appointments.service.ts) ─────────────
//
// When a user confirms payment without supplying a date, the backend defaults to
// Brazil today as UTC midnight — not new Date() (current UTC timestamp).
// The test below documents the invariant: Brazil calendar date must not shift.

describe('paymentDate default — Brazil today as UTC midnight', () => {
  it('at UTC 02:00 (= Brazil May 31 23:00), brazilTodayIso returns May 31, not June 1', () => {
    const now = new Date('2026-06-01T02:00:00Z');
    expect(brazilTodayIso(now)).toBe('2026-05-31');
  });

  it('constructing UTC midnight from Brazil today gives the correct UTC date components', () => {
    // This is what appointments.service.ts now does when no paymentDate is given:
    //   new Date(`${brazilTodayIso()}T00:00:00.000Z`)
    const now = new Date('2026-06-01T02:00:00Z'); // 23:00 Brazil May 31
    const brazilToday = brazilTodayIso(now); // '2026-05-31'
    const utcMidnight = new Date(`${brazilToday}T00:00:00.000Z`);

    expect(utcMidnight.getUTCFullYear()).toBe(2026);
    expect(utcMidnight.getUTCMonth()).toBe(4); // 0-indexed May
    expect(utcMidnight.getUTCDate()).toBe(31);
  });

  it('dateOnly() on Brazil-today UTC midnight preserves May 31 (not June 1)', () => {
    // The service calls this.dateOnly(paymentDate) to derive transactionDate.
    // dateOnly extracts UTC year/month/day — must be May 31, not June 1.
    const now = new Date('2026-06-01T02:00:00Z');
    const brazilToday = brazilTodayIso(now); // '2026-05-31'
    const paymentDate = new Date(`${brazilToday}T00:00:00.000Z`);
    // Simulate dateOnly():
    const transactionDate = new Date(
      Date.UTC(paymentDate.getUTCFullYear(), paymentDate.getUTCMonth(), paymentDate.getUTCDate()),
    );
    expect(transactionDate.toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });
});
