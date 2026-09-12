import { BadRequestException } from '@nestjs/common';
import { brazilTodayIso } from './brazil-timezone';

const MAX_REPORT_MONTHS = 12;

function todayIso(): string {
  return brazilTodayIso();
}

function parseIsoDate(str: string): Date | null {
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return isNaN(date.getTime()) ? null : date;
}

export function validateReportDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  opts: { allowFuture?: boolean } = {},
): void {
  const { allowFuture = false } = opts;

  if (!startDate && !endDate) return;

  if (endDate && !allowFuture) {
    const end = parseIsoDate(endDate);
    const today = parseIsoDate(todayIso())!;
    if (end && end > today) {
      throw new BadRequestException(
        'A data final não pode ser futura para este relatório.',
      );
    }
  }

  if (!startDate || !endDate) return;

  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end) return;

  if (end < start) {
    throw new BadRequestException(
      'A data final não pode ser anterior à data inicial.',
    );
  }

  const limitDate = new Date(start);
  limitDate.setUTCMonth(limitDate.getUTCMonth() + MAX_REPORT_MONTHS);
  if (end > limitDate) {
    throw new BadRequestException(
      'Selecione um período de até 12 meses por vez.',
    );
  }
}
