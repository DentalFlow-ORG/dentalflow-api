import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AdminCreateUserDto } from './admin-create-user.dto';
import { AdminUpdateUserDto } from './admin-update-user.dto';
import { CreateMemberDto } from './create-member.dto';
import { UpdateUserDto } from './update-user.dto';

// The DTO classes under test share the fields checked here, so the parameter
// is typed loosely and each assertion reads the fields it needs.
type UserDtoFields = { phone?: string | null };

async function check(cls: new () => object, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload) as UserDtoFields;
  const errors = await validate(instance);
  return {
    instance,
    props: errors.map((error) => error.property),
    messages: errors.flatMap((error) => Object.values(error.constraints ?? {})),
  };
}

const newMember = {
  firstName: 'Ana',
  lastName: 'Martins',
  email: 'ana@example.test',
  role: 'DENTIST',
};

describe('user DTO validation', () => {
  // The initial password now follows the same policy as a reset, so a weak
  // password can no longer be set at creation and then refused on reset.
  describe.each([
    ['CreateMemberDto', CreateMemberDto, newMember],
    [
      'AdminCreateUserDto',
      AdminCreateUserDto,
      { ...newMember, clinicId: 'clinic-1' },
    ],
  ] as const)('%s password', (_name, cls, base) => {
    it('accepts a password meeting the complexity policy', async () => {
      const { props } = await check(cls, { ...base, password: 'Str0ng!pass' });
      expect(props).not.toContain('password');
    });

    it.each(['12345678', 'abcdefgh', 'Abcdefgh', 'Abcdefg1'])(
      'rejects the weak password %j',
      async (password) => {
        const { props } = await check(cls, { ...base, password });
        expect(props).toContain('password');
      },
    );
  });

  describe.each([
    ['UpdateUserDto', UpdateUserDto],
    ['AdminUpdateUserDto', AdminUpdateUserDto],
  ] as const)('%s', (_name, cls) => {
    it('clears the phone with null or a blank string', async () => {
      const fromNull = await check(cls, { phone: null });
      const fromBlank = await check(cls, { phone: ' ' });
      expect(fromNull.props).toEqual([]);
      expect(fromBlank.props).toEqual([]);
      expect(fromNull.instance.phone).toBeNull();
      expect(fromBlank.instance.phone).toBeNull();
    });

    it('normalises a masked phone to digits', async () => {
      const { props, instance } = await check(cls, {
        phone: '(61) 99876-5432',
      });
      expect(props).toEqual([]);
      expect(instance.phone).toBe('61998765432');
    });

    it.each(['firstName', 'lastName', 'email', 'role', 'isActive'])(
      'refuses null for %s',
      async (field) => {
        const { props } = await check(cls, { [field]: null });
        expect(props).toContain(field);
      },
    );

    it('explains an invalid name in Portuguese', async () => {
      const { messages } = await check(cls, { firstName: 'Ana3' });
      expect(messages).toContain(
        'O nome deve conter apenas letras, espaços, acentos, apóstrofos, pontos e hífens.',
      );
    });
  });
});
