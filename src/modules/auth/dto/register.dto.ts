import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  normalizeEmail,
  trimValue,
} from '../../../common/utils/transform.helpers';
import {
  PASSWORD_COMPLEXITY_MESSAGE,
  PASSWORD_COMPLEXITY_REGEX,
} from '../../../common/validators/password-policy';
import {
  PERSON_NAME_PATTERN,
  personNameMessage,
  SAFE_TEXT_PATTERN,
} from '../../../common/validators/br-field-patterns';

export class RegisterDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Matches(SAFE_TEXT_PATTERN, {
    message:
      'O nome da clínica deve conter apenas letras, números, espaços, apóstrofos, pontos e hífens.',
  })
  clinicName!: string;

  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(PASSWORD_COMPLEXITY_REGEX, { message: PASSWORD_COMPLEXITY_MESSAGE })
  password!: string;

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

  @IsBoolean()
  @Equals(true, {
    message:
      'Você precisa aceitar os Termos de Uso e a Política de Privacidade para criar uma conta.',
  })
  acceptedTerms!: boolean;
}
