import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizeEmail, normalizePhone, trimValue } from '../../../common/utils/transform.helpers';

const personNamePattern = /^[\p{L}\s.'-]+$/u;
const brPhonePattern = /^\d{10,11}$/;

export class UpdateUserDto {
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
  @Matches(brPhonePattern, { message: 'phone must be a valid Brazilian number with DDD (10 or 11 digits)' })
  phone?: string;

  @IsOptional()
  @IsIn(['DENTIST', 'ASSISTANT'])
  role?: 'DENTIST' | 'ASSISTANT';
}
