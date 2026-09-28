import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  blankToNull,
  blankToNullDigits,
  blankToNullPhone,
  trimValue,
} from '../../../common/utils/transform.helpers';
import {
  BR_PHONE_DIGITS_PATTERN,
  BR_PHONE_MESSAGE,
  BRAZILIAN_UFS,
  CEP_DIGITS_PATTERN,
} from '../../../common/validators/br-field-patterns';
import { IsOptionalButNotNull } from '../../../common/validators/input-validation.decorators';

/**
 * PATCH contract: an absent field is left unchanged; `null` or a blank string
 * clears an optional field. The clinic name is required and cannot be cleared.
 */
const blank = ({ value }: { value: unknown }) => blankToNull(value);
const blankOrDigits = ({ value }: { value: unknown }) =>
  blankToNullDigits(value);

export class UpdateClinicProfileDto {
  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString({ message: 'Informe o nome da clínica.' })
  @IsNotEmpty({ message: 'Informe o nome da clínica.' })
  @MinLength(2, {
    message: 'O nome da clínica deve ter ao menos 2 caracteres.',
  })
  @MaxLength(100, {
    message: 'O nome da clínica deve ter no máximo 100 caracteres.',
  })
  name?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? blankToNull(value.toLowerCase()) : value,
  )
  @IsOptional()
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  @MaxLength(254, { message: 'O e-mail deve ter no máximo 254 caracteres.' })
  email?: string | null;

  @Transform(({ value }: { value: unknown }) => blankToNullPhone(value))
  @IsOptional()
  @IsString()
  @Matches(BR_PHONE_DIGITS_PATTERN, { message: BR_PHONE_MESSAGE })
  phone?: string | null;

  @Transform(blank)
  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'Informe uma URL válida, começando com http:// ou https://.' },
  )
  @MaxLength(200, { message: 'O site deve ter no máximo 200 caracteres.' })
  websiteUrl?: string | null;

  @Transform(blank)
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'O endereço deve ter no máximo 200 caracteres.' })
  addressLine1?: string | null;

  @Transform(blank)
  @IsOptional()
  @IsString()
  @MaxLength(200, {
    message: 'O complemento deve ter no máximo 200 caracteres.',
  })
  addressLine2?: string | null;

  @Transform(blank)
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'A cidade deve ter no máximo 100 caracteres.' })
  city?: string | null;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? blankToNull(value.toUpperCase()) : value,
  )
  @IsOptional()
  @IsIn(BRAZILIAN_UFS, {
    message: 'Informe uma sigla de estado válida (ex: SP, RJ).',
  })
  state?: string | null;

  @Transform(blankOrDigits)
  @IsOptional()
  @IsString()
  @Matches(CEP_DIGITS_PATTERN, { message: 'Informe um CEP com 8 dígitos.' })
  postalCode?: string | null;
}
