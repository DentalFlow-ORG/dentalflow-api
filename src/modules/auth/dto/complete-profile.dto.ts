import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { trimValue } from '../../../common/utils/transform.helpers';
import {
  PERSON_NAME_PATTERN,
  personNameMessage,
  SAFE_TEXT_PATTERN,
} from '../../../common/validators/br-field-patterns';

export class CompleteProfileDto {
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
