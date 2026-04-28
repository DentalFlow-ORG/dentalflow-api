import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsEmail } from 'class-validator';
import { normalizeEmail, trimValue } from '../../auth/dto/transform.helpers';

const safeTextPattern = /^[\p{L}\p{N}\s.'-]+$/u;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateMemberDto {
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

  @IsIn(['DENTIST', 'ASSISTANT'])
  role!: 'DENTIST' | 'ASSISTANT';

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  // Profile fields — only used when role === 'DENTIST'

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  displayName?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  @Matches(slugPattern, {
    message: 'slug must contain only lowercase letters, numbers, and hyphens',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  crmNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  crmState?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specialtyIds?: string[];
}
