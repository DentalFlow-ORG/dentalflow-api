import { ValidateBy } from 'class-validator';

export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MAX_ID_LENGTH = 64;
export const MAX_MONEY_AMOUNT = 99_999_999.99;
export const MAX_CENTS_AMOUNT = 999_999_999;

export function IsSafeId() {
  return ValidateBy({
    name: 'isSafeId',
    validator: {
      validate(value: unknown) {
        return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
      },
      defaultMessage() {
        return 'Identificador invalido.';
      },
    },
  });
}

export function IsCalendarDate() {
  return ValidateBy({
    name: 'isCalendarDate',
    validator: {
      validate(value: unknown) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return false;
        }

        const date = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
      },
      defaultMessage() {
        return 'Data invalida.';
      },
    },
  });
}

export function IsClockTime() {
  return ValidateBy({
    name: 'isClockTime',
    validator: {
      validate(value: unknown) {
        if (typeof value !== 'string') {
          return false;
        }

        const match = value.match(/^(\d{2}):(\d{2})$/);
        if (!match) {
          return false;
        }

        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
      },
      defaultMessage() {
        return 'Horario invalido.';
      },
    },
  });
}
