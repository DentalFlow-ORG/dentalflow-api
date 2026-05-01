import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '@prisma/client';
import { normalizeEmail, normalizePhone, trimValue } from '../../../common/utils/transform.helpers';

const personNamePattern = /^[\p{L}\s.'-]+$/u;
const brPhonePattern = /^\d{10,11}$/;

export class AdminUpdateUserDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(personNamePattern, { message: 'firstName must contain only letters, spaces, accents, apostrophes, dots and hyphens' })
  firstName?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(personNamePattern, { message: 'lastName must contain only letters, spaces, accents, apostrophes, dots and hyphens' })
  lastName?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(brPhonePattern, { message: 'Telefone deve ser um número brasileiro válido com DDD e 10 ou 11 dígitos' })
  phone?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  clinicId?: string;
}
