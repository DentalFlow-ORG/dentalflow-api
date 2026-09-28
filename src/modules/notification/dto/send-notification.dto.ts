import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizePhone } from '../../../common/utils/transform.helpers';
import { BR_PHONE_DIGITS_PATTERN } from '../../../common/validators/br-field-patterns';

export class SendNotificationDto {
  @IsString()
  @MaxLength(100)
  templateSlug!: string;

  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(BR_PHONE_DIGITS_PATTERN, {
    message:
      'Telefone deve ser um número brasileiro válido com DDD (10 ou 11 dígitos)',
  })
  phone!: string;

  @IsOptional()
  @IsString()
  appointmentId?: string;
}
