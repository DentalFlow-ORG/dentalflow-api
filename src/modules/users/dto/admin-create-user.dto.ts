import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '@prisma/client';

const ALLOWED_ADMIN_ROLES: UserRole[] = [
  'ADMIN',
  'OWNER',
  'DENTIST',
  'ASSISTANT',
];
import {
  normalizeEmail,
  normalizePhone,
  trimValue,
} from '../../../common/utils/transform.helpers';
import {
  BR_PHONE_DIGITS_PATTERN,
  PERSON_NAME_PATTERN,
  personNameMessage,
} from '../../../common/validators/br-field-patterns';
import {
  PASSWORD_COMPLEXITY_MESSAGE,
  PASSWORD_COMPLEXITY_REGEX,
} from '../../../common/validators/password-policy';

export class AdminCreateUserDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  @Matches(PERSON_NAME_PATTERN, {
    message: personNameMessage('O nome'),
  })
  firstName!: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  @Matches(PERSON_NAME_PATTERN, {
    message: personNameMessage('O sobrenome'),
  })
  lastName!: string;

  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(PASSWORD_COMPLEXITY_REGEX, { message: PASSWORD_COMPLEXITY_MESSAGE })
  password!: string;

  @IsIn(ALLOWED_ADMIN_ROLES, {
    message: 'role must be ADMIN, OWNER, DENTIST or ASSISTANT',
  })
  role!: UserRole;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  clinicId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(BR_PHONE_DIGITS_PATTERN, {
    message:
      'Telefone deve ser um número brasileiro válido com DDD e 10 ou 11 dígitos',
  })
  phone?: string;
}
