export function trimValue(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export function digitsOnly(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\D/g, '') : value;
}

export function normalizePhone(value: unknown): unknown {
  return typeof value === 'string'
    ? (toCanonicalBrazilianPhone(value) ?? digitsOnly(value))
    : value;
}

/**
 * For optional text fields: a blank submission ('' or whitespace only) means
 * "not provided". Without this, `@IsOptional()` lets '' through to format
 * validators such as `@IsEmail()` and an empty optional field fails.
 */
export function blankToUndefined(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * For optional text fields on a PATCH: a blank submission clears the stored
 * value (null), while an absent field (undefined) leaves it unchanged.
 */
export function blankToNull(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Optional digit fields (phone, CEP) on a PATCH: blank clears (null), any
 * other string keeps only its digits so a mask can be sent as typed.
 */
export function blankToNullDigits(value: unknown): unknown {
  const cleared = blankToNull(value);
  return typeof cleared === 'string' ? digitsOnly(cleared) : cleared;
}

/**
 * Optional nullable number fields: a blank submission means "not set" (null),
 * never 0 — `@Type(() => Number)` would turn '' into 0 and silently store a
 * value nobody entered. Numeric strings become numbers; anything else is left
 * for the validators to reject.
 */
export function blankToNullNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? value : parsed;
}

/**
 * Canonical storage form of a Brazilian phone: digits only, DDD + 8 or 9
 * digits, no country code. Returns null when the value is not recognisably a
 * Brazilian number, so callers can keep the original rather than lose data.
 *
 * "55" is also the DDD of Rio Grande do Sul, so a leading 55 is only treated
 * as the country code when the input is explicitly international ("+"/"00")
 * or is a full 13-digit number — the same rule as the web client's mask.
 */
export function toCanonicalBrazilianPhone(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  const isInternational = /^\s*(\+|00)/.test(value);
  if (isInternational && digits.startsWith('0055')) digits = digits.slice(4);
  else if (
    digits.startsWith('55') &&
    (isInternational || digits.length === 13)
  ) {
    digits = digits.slice(2);
  }
  return /^\d{10,11}$/.test(digits) ? digits : null;
}

/** Nullable phone PATCH: blank clears; an omitted field remains unchanged. */
export function blankToNullPhone(value: unknown): unknown {
  return normalizePhone(blankToNull(value));
}

/** Legacy snapshots can contain non-Brazilian contacts: never erase those. */
export function normalizePhoneSnapshot(value: unknown): unknown {
  return typeof value === 'string'
    ? (toCanonicalBrazilianPhone(value) ?? value)
    : value;
}
