import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
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
  blankToNullPhone,
  trimValue,
} from '../../../common/utils/transform.helpers';
import {
  BR_PHONE_DIGITS_PATTERN,
  PERSON_NAME_PATTERN,
  personNameMessage,
} from '../../../common/validators/br-field-patterns';
import { IsOptionalButNotNull } from '../../../common/validators/input-validation.decorators';

export class AdminUpdateUserDto {
  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(PERSON_NAME_PATTERN, {
    message: personNameMessage('O nome'),
  })
  firstName?: string;

  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(PERSON_NAME_PATTERN, {
    message: personNameMessage('O sobrenome'),
  })
  lastName?: string;

  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email?: string;

  // `null` (or a blank string) clears the phone; absent leaves it unchanged.
  @Transform(({ value }: { value: unknown }) => blankToNullPhone(value))
  @IsOptional()
  @IsString()
  @Matches(BR_PHONE_DIGITS_PATTERN, {
    message:
      'Telefone deve ser um número brasileiro válido com DDD e 10 ou 11 dígitos',
  })
  phone?: string | null;

  @IsOptionalButNotNull()
  @IsIn(ALLOWED_ADMIN_ROLES, {
    message: 'role must be ADMIN, OWNER, DENTIST or ASSISTANT',
  })
  role?: UserRole;

  @IsOptionalButNotNull()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  clinicId?: string;
}
