import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '@prisma/client';
import { normalizeEmail, trimValue } from '../../../common/utils/transform.helpers';

const safeTextPattern = /^[\p{L}\p{N}\s.'-]+$/u;

export class AdminCreateUserDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  @Matches(safeTextPattern, { message: 'firstName contains unsupported characters' })
  firstName!: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  @Matches(safeTextPattern, { message: 'lastName contains unsupported characters' })
  lastName!: string;

  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsEnum(UserRole)
  role!: UserRole;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  clinicId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
