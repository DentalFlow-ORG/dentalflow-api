import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RegisterDto } from './register.dto';
import { ResetPasswordDto } from './reset-password.dto';
import { UpdatePasswordDto } from '../../users/dto/update-password.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

const VALID_PASSWORD = 'Str0ng@Pass!';
const WEAK_PASSWORDS = [
  { label: 'no uppercase', value: 'str0ng@pass!' },
  { label: 'no lowercase', value: 'STR0NG@PASS!' },
  { label: 'no digit', value: 'Strong@Pass!' },
  { label: 'no special char', value: 'Str0ngPass1' },
  { label: 'too short', value: 'S1@a' },
];

const VALID_REGISTER_BASE = {
  clinicName: 'Clínica Teste',
  email: 'owner@clinic.com',
  firstName: 'João',
  lastName: 'Silva',
  acceptedTerms: true,
};

describe('auth DTO password policy', () => {
  describe('RegisterDto', () => {
    it('accepts a valid complex password', async () => {
      const errors = await validateDto(RegisterDto, {
        ...VALID_REGISTER_BASE,
        password: VALID_PASSWORD,
      });
      expect(errors.some((e) => e.property === 'password')).toBe(false);
    });

    it.each(WEAK_PASSWORDS)(
      'rejects password with $label',
      async ({ value }) => {
        const errors = await validateDto(RegisterDto, {
          ...VALID_REGISTER_BASE,
          password: value,
        });
        expect(errors.some((e) => e.property === 'password')).toBe(true);
      },
    );
  });

  describe('UpdatePasswordDto', () => {
    it('accepts a valid complex password', async () => {
      const errors = await validateDto(UpdatePasswordDto, {
        password: VALID_PASSWORD,
      });
      expect(errors.some((e) => e.property === 'password')).toBe(false);
    });

    it.each(WEAK_PASSWORDS)(
      'rejects password with $label',
      async ({ value }) => {
        const errors = await validateDto(UpdatePasswordDto, {
          password: value,
        });
        expect(errors.some((e) => e.property === 'password')).toBe(true);
      },
    );
  });

  describe('ResetPasswordDto', () => {
    it('accepts a valid complex password', async () => {
      const errors = await validateDto(ResetPasswordDto, {
        token: 'some-token',
        newPassword: VALID_PASSWORD,
      });
      expect(errors.some((e) => e.property === 'newPassword')).toBe(false);
    });

    it.each(WEAK_PASSWORDS)(
      'rejects newPassword with $label',
      async ({ value }) => {
        const errors = await validateDto(ResetPasswordDto, {
          token: 'some-token',
          newPassword: value,
        });
        expect(errors.some((e) => e.property === 'newPassword')).toBe(true);
      },
    );
  });
});
