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

const personNamePattern = /^[\p{L}\s.'-]+$/u;
const brPhonePattern = /^\d{10,11}$/;

export class AdminCreateUserDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  @Matches(personNamePattern, {
    message:
      'firstName must contain only letters, spaces, accents, apostrophes, dots and hyphens',
  })
  firstName!: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  @Matches(personNamePattern, {
    message:
      'lastName must contain only letters, spaces, accents, apostrophes, dots and hyphens',
  })
  lastName!: string;

  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
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
  @Matches(brPhonePattern, {
    message:
      'Telefone deve ser um número brasileiro válido com DDD e 10 ou 11 dígitos',
  })
  phone?: string;
}
