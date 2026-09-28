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
import {
  normalizeEmail,
  normalizePhone,
  trimValue,
} from '../../../common/utils/transform.helpers';
import { MAX_ID_LENGTH } from '../../../common/validators/input-validation.decorators';
import {
  BR_PHONE_DIGITS_PATTERN,
  PERSON_NAME_PATTERN,
  personNameMessage,
  SLUG_PATTERN,
} from '../../../common/validators/br-field-patterns';
import {
  PASSWORD_COMPLEXITY_MESSAGE,
  PASSWORD_COMPLEXITY_REGEX,
} from '../../../common/validators/password-policy';

export class CreateMemberDto {
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

  @IsIn(['DENTIST', 'ASSISTANT'])
  role!: 'DENTIST' | 'ASSISTANT';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(BR_PHONE_DIGITS_PATTERN, {
    message:
      'Telefone deve ser um número brasileiro válido com DDD e 10 ou 11 dígitos',
  })
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
  @Matches(SLUG_PATTERN, {
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
  @MaxLength(MAX_ID_LENGTH, { each: true })
  specialtyIds?: string[];
}
