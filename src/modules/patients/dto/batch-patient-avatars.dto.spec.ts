import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { BatchPatientAvatarsDto, BATCH_AVATARS_MAX_COUNT } from './batch-patient-avatars.dto';

async function validateDto(payload: Record<string, unknown>) {
  return validate(plainToInstance(BatchPatientAvatarsDto, payload));
}

describe('BatchPatientAvatarsDto validation', () => {
  it('accepts a valid array of identifiers', async () => {
    const errors = await validateDto({ identifiers: ['a@test.com', 'João Silva'] });
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing identifiers field', async () => {
    const errors = await validateDto({});
    expect(errors.some((e) => e.property === 'identifiers')).toBe(true);
  });

  it('rejects an empty array', async () => {
    const errors = await validateDto({ identifiers: [] });
    expect(errors.some((e) => e.property === 'identifiers')).toBe(true);
  });

  it('rejects when identifiers exceeds the max count', async () => {
    const errors = await validateDto({
      identifiers: Array.from({ length: BATCH_AVATARS_MAX_COUNT + 1 }, (_, i) => `p${i}@test.com`),
    });
    expect(errors.some((e) => e.property === 'identifiers')).toBe(true);
  });

  it('accepts exactly the max allowed count', async () => {
    const errors = await validateDto({
      identifiers: Array.from({ length: BATCH_AVATARS_MAX_COUNT }, (_, i) => `p${i}@test.com`),
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects an identifier that exceeds MaxLength(320)', async () => {
    const errors = await validateDto({ identifiers: ['a'.repeat(321)] });
    expect(errors.some((e) => e.property === 'identifiers')).toBe(true);
  });

  it('accepts identifiers of exactly 320 characters', async () => {
    const errors = await validateDto({ identifiers: ['a'.repeat(320)] });
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-array value', async () => {
    const errors = await validateDto({ identifiers: 'not-an-array' });
    expect(errors.some((e) => e.property === 'identifiers')).toBe(true);
  });

  it('rejects an array containing an empty string', async () => {
    const errors = await validateDto({ identifiers: ['valid@test.com', ''] });
    expect(errors.some((e) => e.property === 'identifiers')).toBe(true);
  });

  it('trims whitespace from identifiers via @Transform', () => {
    const instance = plainToInstance(BatchPatientAvatarsDto, {
      identifiers: ['  a@test.com  ', ' João Silva '],
    });
    expect(instance.identifiers).toEqual(['a@test.com', 'João Silva']);
  });

  it('rejects an identifier that is whitespace-only after trimming', async () => {
    const errors = await validateDto({ identifiers: ['   '] });
    expect(errors.some((e) => e.property === 'identifiers')).toBe(true);
  });
});
