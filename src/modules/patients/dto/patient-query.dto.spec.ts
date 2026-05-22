import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ListPatientsQueryDto, PatientHistoryQueryDto } from './patient-query.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

describe('patient query DTO validation', () => {
  it('rejects overlong search', async () => {
    const errors = await validateDto(ListPatientsQueryDto, {
      search: 'a'.repeat(101),
    });

    expect(errors.some((error) => error.property === 'search')).toBe(true);
  });

  it('rejects missing history identifier', async () => {
    const errors = await validateDto(PatientHistoryQueryDto, {});

    expect(errors).toHaveLength(1);
  });

  it('rejects empty history identifier after trimming', async () => {
    const errors = await validateDto(PatientHistoryQueryDto, {
      identifier: '   ',
    });

    expect(errors).toHaveLength(1);
  });

  it('rejects overlong history identifier', async () => {
    const errors = await validateDto(PatientHistoryQueryDto, {
      identifier: 'a'.repeat(255),
    });

    expect(errors.some((error) => error.property === 'identifier')).toBe(true);
  });
});
