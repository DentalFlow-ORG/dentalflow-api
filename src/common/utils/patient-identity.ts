/**
 * Patient identity resolution.
 *
 * DentalFlow has no Patient entity: a patient is derived from the denormalized
 * `patientName` / `patientEmail` / `patientPhone` columns carried by
 * appointments, clinical records and odontogram records. Every consumer must
 * resolve identity through this module so the patient list, the attention
 * queue, the appointment history and the clinical record/odontogram lookups
 * cannot disagree about who a patient is.
 *
 * Canonical rule
 * --------------
 * An identity key is the trimmed, lower-cased email when an email is present,
 * and the trimmed, lower-cased name otherwise. Email preference is a legacy
 * lookup convention, not a uniqueness or ownership guarantee.
 *
 * Known limitation — see PatientIdentityService
 * -------------------------------------------------------
 * The name-only branch is NOT a stable identity: two different people with the
 * same name and no email collapse into one key. Callers that read or write
 * clinical data must guard that case rather than silently merge it. Shared
 * email and legacy padded values remain unresolved; no stable identity is implied.
 */

/** Matches the identifier shape the API accepts as an email. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trims and lower-cases an email for storage and comparison.
 * Returns null for absent or blank input so callers can store a real NULL
 * instead of an empty string, which would otherwise become its own identity.
 */
export function normalizePatientEmail(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalizes an email for a Prisma write while preserving `undefined`.
 *
 * `undefined` means "field not supplied" on a partial update and must stay
 * undefined so Prisma leaves the stored value alone. Collapsing it to null
 * here would silently erase the email — and therefore the patient's identity —
 * on any update that did not resend it.
 */
export function normalizePatientEmailForWrite(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  return normalizePatientEmail(value);
}

/** Trims a patient name; returns null when nothing is left. */
export function normalizePatientName(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/** True when the identifier should be resolved through the email branch. */
export function isEmailIdentifier(identifier: string): boolean {
  return EMAIL_PATTERN.test(identifier.trim());
}

/**
 * The canonical identity key for a patient-bearing row.
 * Lower-cased on both branches so `Maria@X.com`, `maria@x.com` and
 * ` maria@x.com ` collapse to a single patient.
 */
export function patientIdentityKey(patient: {
  patientEmail?: string | null;
  patientName?: string | null;
}): string {
  const email = normalizePatientEmail(patient.patientEmail);
  if (email) return email;
  return (normalizePatientName(patient.patientName) ?? '').toLowerCase();
}

/**
 * The identifier handed to API clients. Clients echo it back on the history,
 * avatar, clinical record and odontogram endpoints, so it must round-trip
 * through `patientIdentityFilter` unchanged.
 */
export function patientIdentifierFor(patient: {
  patientEmail?: string | null;
  patientName?: string | null;
}): string {
  const email = normalizePatientEmail(patient.patientEmail);
  if (email) return email;
  return normalizePatientName(patient.patientName) ?? '';
}

/**
 * Prisma `where` fragment resolving an identifier to its rows.
 *
 * Both branches match case-insensitively so rows written before identity
 * normalization — which may hold mixed-case or padded values — still resolve.
 * That removes the need to rewrite existing patient data.
 *
 * The name branch additionally requires `patientEmail: null`: a row that has an
 * email belongs to the email branch and must never be reachable by name.
 */
export function patientIdentityFilter(identifier: string): {
  patientEmail?: { equals: string; mode: 'insensitive' } | null;
  patientName?: { equals: string; mode: 'insensitive' };
} {
  const trimmed = identifier.trim();

  if (isEmailIdentifier(trimmed)) {
    return {
      patientEmail: { equals: trimmed.toLowerCase(), mode: 'insensitive' },
    };
  }

  return {
    patientName: { equals: trimmed, mode: 'insensitive' },
    patientEmail: null,
  };
}
