import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  MAX_CENTS_AMOUNT,
  MAX_ID_LENGTH,
  MAX_MONEY_AMOUNT,
} from '../../../common/validators/input-validation.decorators';
import { CreateServiceDto } from './create-service.dto';
import { UpdateServiceDto } from './update-service.dto';
import { SetProfileSpecialtiesDto } from './set-profile-specialties.dto';
import { CreateMemberDto } from '../../users/dto/create-member.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

describe('profiles DTO validation', () => {
  describe('service price bounds', () => {
    it('rejects priceFrom above MAX_MONEY_AMOUNT', async () => {
      const errors = await validateDto(CreateServiceDto, {
        name: 'Clareamento',
        priceFrom: MAX_MONEY_AMOUNT + 1,
      });
      expect(errors.some((e) => e.property === 'priceFrom')).toBe(true);
    });

    it('rejects priceTo above MAX_MONEY_AMOUNT', async () => {
      const errors = await validateDto(CreateServiceDto, {
        name: 'Clareamento',
        priceTo: MAX_MONEY_AMOUNT + 1,
      });
      expect(errors.some((e) => e.property === 'priceTo')).toBe(true);
    });

    it('accepts priceFrom at exactly 0 (boundary)', async () => {
      const errors = await validateDto(CreateServiceDto, {
        name: 'Clareamento',
        priceFrom: 0,
      });
      expect(errors.some((e) => e.property === 'priceFrom')).toBe(false);
    });

    it('accepts priceFrom at exactly MAX_MONEY_AMOUNT (boundary)', async () => {
      const errors = await validateDto(CreateServiceDto, {
        name: 'Clareamento',
        priceFrom: MAX_MONEY_AMOUNT,
      });
      expect(errors.some((e) => e.property === 'priceFrom')).toBe(false);
    });

    it('rejects priceTo above MAX_MONEY_AMOUNT in UpdateServiceDto', async () => {
      const errors = await validateDto(UpdateServiceDto, {
        priceTo: MAX_MONEY_AMOUNT + 0.01,
      });
      expect(errors.some((e) => e.property === 'priceTo')).toBe(true);
    });
  });

  describe('SetProfileSpecialtiesDto specialtyIds per-element length', () => {
    it('rejects an element longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(SetProfileSpecialtiesDto, {
        specialtyIds: ['valid_id', 'a'.repeat(MAX_ID_LENGTH + 1)],
      });
      expect(errors.some((e) => e.property === 'specialtyIds')).toBe(true);
    });

    it('accepts valid IDs within length', async () => {
      const errors = await validateDto(SetProfileSpecialtiesDto, {
        specialtyIds: ['specialty-1', 'specialty-2'],
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts an empty specialtyIds array', async () => {
      const errors = await validateDto(SetProfileSpecialtiesDto, {
        specialtyIds: [],
      });
      expect(errors).toHaveLength(0);
    });
  });

  describe('service estimatedDirectCostCents', () => {
    it('accepts undefined (field is optional)', async () => {
      const errors = await validateDto(CreateServiceDto, { name: 'Limpeza' });
      expect(
        errors.some((e) => e.property === 'estimatedDirectCostCents'),
      ).toBe(false);
    });

    it('accepts 0 (minimum boundary)', async () => {
      const errors = await validateDto(CreateServiceDto, {
        name: 'Limpeza',
        estimatedDirectCostCents: 0,
      });
      expect(
        errors.some((e) => e.property === 'estimatedDirectCostCents'),
      ).toBe(false);
    });

    it('accepts MAX_CENTS_AMOUNT (maximum boundary)', async () => {
      const errors = await validateDto(CreateServiceDto, {
        name: 'Limpeza',
        estimatedDirectCostCents: MAX_CENTS_AMOUNT,
      });
      expect(
        errors.some((e) => e.property === 'estimatedDirectCostCents'),
      ).toBe(false);
    });

    it('rejects a value above MAX_CENTS_AMOUNT', async () => {
      const errors = await validateDto(CreateServiceDto, {
        name: 'Limpeza',
        estimatedDirectCostCents: MAX_CENTS_AMOUNT + 1,
      });
      expect(
        errors.some((e) => e.property === 'estimatedDirectCostCents'),
      ).toBe(true);
    });

    it('rejects a negative value', async () => {
      const errors = await validateDto(UpdateServiceDto, {
        estimatedDirectCostCents: -1,
      });
      expect(
        errors.some((e) => e.property === 'estimatedDirectCostCents'),
      ).toBe(true);
    });

    it('rejects a non-integer (decimal)', async () => {
      const errors = await validateDto(UpdateServiceDto, {
        estimatedDirectCostCents: 1500.5,
      });
      expect(
        errors.some((e) => e.property === 'estimatedDirectCostCents'),
      ).toBe(true);
    });
  });

  describe('UpdateServiceDto null-clearing (clearable optional fields)', () => {
    it('accepts null for description (clears the field)', async () => {
      const errors = await validateDto(UpdateServiceDto, { description: null });
      expect(errors.some((e) => e.property === 'description')).toBe(false);
    });

    it('accepts null for priceFrom (clears the field)', async () => {
      const errors = await validateDto(UpdateServiceDto, { priceFrom: null });
      expect(errors.some((e) => e.property === 'priceFrom')).toBe(false);
    });

    it('accepts null for priceTo (clears the field)', async () => {
      const errors = await validateDto(UpdateServiceDto, { priceTo: null });
      expect(errors.some((e) => e.property === 'priceTo')).toBe(false);
    });

    it('accepts null for durationMinutes (clears the field)', async () => {
      const errors = await validateDto(UpdateServiceDto, {
        durationMinutes: null,
      });
      expect(errors.some((e) => e.property === 'durationMinutes')).toBe(false);
    });

    it('accepts null for estimatedDirectCostCents (clears the field)', async () => {
      const errors = await validateDto(UpdateServiceDto, {
        estimatedDirectCostCents: null,
      });
      expect(
        errors.some((e) => e.property === 'estimatedDirectCostCents'),
      ).toBe(false);
    });
  });

  describe('CreateMemberDto specialtyIds per-element length', () => {
    it('rejects a specialty ID longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(CreateMemberDto, {
        firstName: 'Ana',
        lastName: 'Lima',
        email: 'ana@clinic.com',
        password: 'Str0ngPass!',
        role: 'DENTIST',
        specialtyIds: ['a'.repeat(MAX_ID_LENGTH + 1)],
      });
      expect(errors.some((e) => e.property === 'specialtyIds')).toBe(true);
    });

    it('accepts valid specialtyIds within length', async () => {
      const errors = await validateDto(CreateMemberDto, {
        firstName: 'Ana',
        lastName: 'Lima',
        email: 'ana@clinic.com',
        password: 'Str0ngPass!',
        role: 'DENTIST',
        specialtyIds: ['specialty-1', 'specialty-2'],
      });
      expect(errors.some((e) => e.property === 'specialtyIds')).toBe(false);
    });
  });
});
