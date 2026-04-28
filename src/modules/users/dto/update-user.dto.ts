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
import { normalizeEmail, trimValue } from '../../auth/dto/transform.helpers';

const safeTextPattern = /^[\p{L}\p{N}\s.'-]+$/u;

export class UpdateUserDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(safeTextPattern, { message: 'firstName contains unsupported characters' })
  firstName?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(safeTextPattern, { message: 'lastName contains unsupported characters' })
  lastName?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsIn(['DENTIST', 'ASSISTANT'])
  role?: 'DENTIST' | 'ASSISTANT';
}
