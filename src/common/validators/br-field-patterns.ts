/**
 * Field formats shared by every DTO that accepts them. Kept in one place so a
 * rule cannot drift between modules (the web client mirrors these in
 * src/lib/validators).
 */

/** Brazilian phone after `normalizePhone`: DDD + 8 or 9 digits. */
export const BR_PHONE_DIGITS_PATTERN = /^\d{10,11}$/;
export const BR_PHONE_MESSAGE =
  'Telefone deve ser um número brasileiro válido com DDD e 10 ou 11 dígitos';

/** Letters (any script, accents included), spaces, apostrophes, dots, hyphens. */
export const PERSON_NAME_PATTERN = /^[\p{L}\s.'-]+$/u;
export function personNameMessage(fieldLabel: string): string {
  return `${fieldLabel} deve conter apenas letras, espaços, acentos, apóstrofos, pontos e hífens.`;
}

/** Organisation names: person-name characters plus digits. */
export const SAFE_TEXT_PATTERN = /^[\p{L}\p{N}\s.'-]+$/u;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CEP_DIGITS_PATTERN = /^\d{8}$/;
export const IBGE_CITY_CODE_PATTERN = /^\d{7}$/;

export const BRAZILIAN_UFS = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;
