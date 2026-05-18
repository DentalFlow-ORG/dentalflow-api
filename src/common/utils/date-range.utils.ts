import { BadRequestException } from '@nestjs/common';

const MAX_REPORT_MONTHS = 12;
const MAX_FOLLOW_UP_MONTHS = 24;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

export function validateFollowUpDate(
  nextFollowUpAt: string | undefined,
  isCreate: boolean,
): void {
  if (!nextFollowUpAt) return;

  const dateStr = nextFollowUpAt.slice(0, 10);
  const today = todayIso();

  if (isCreate && dateStr < today) {
    throw new BadRequestException(
      'O follow-up não pode ser anterior à data atual.',
    );
  }

  const maxDate = new Date();
  maxDate.setUTCMonth(maxDate.getUTCMonth() + MAX_FOLLOW_UP_MONTHS);
  const maxIso = maxDate.toISOString().slice(0, 10);

  if (dateStr > maxIso) {
    throw new BadRequestException(
      'A data de follow-up deve estar dentro dos próximos 24 meses.',
    );
  }
}
