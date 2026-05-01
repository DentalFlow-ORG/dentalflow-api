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
import { normalizeEmail, trimValue } from '../../../common/utils/transform.helpers';

const safeTextPattern = /^[\p{L}\p{N}\s.'-]+$/u;

export class AdminUpdateUserDto {
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
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  clinicId?: string;
}
