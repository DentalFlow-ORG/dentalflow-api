export function trimValue(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export function normalizePhone(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\D/g, '') : value;
}
