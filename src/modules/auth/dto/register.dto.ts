import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizeEmail, trimValue } from '../../../common/utils/transform.helpers';

const safeTextPattern = /^[\p{L}\p{N}\s.'-]+$/u;
const personNamePattern = /^[\p{L}\s.'-]+$/u;

export class RegisterDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Matches(safeTextPattern, {
    message: 'clinicName contains unsupported characters',
  })
  clinicName!: string;

  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  @Matches(personNamePattern, {
    message: 'firstName must contain only letters, spaces, accents, apostrophes, dots and hyphens',
  })
  firstName!: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  @Matches(personNamePattern, {
    message: 'lastName must contain only letters, spaces, accents, apostrophes, dots and hyphens',
  })
  lastName!: string;
}
