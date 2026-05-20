import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizePhone } from '../../../common/utils/transform.helpers';

export class CreatePublicLeadDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(({ value }) => normalizePhone(value))
  @IsString()
  @Matches(/^\d{10,11}$/, { message: 'Informe um telefone válido com DDD (10 ou 11 dígitos).' })
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  clinicName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  preferredTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  context?: string;

  @IsBoolean()
  acceptedPrivacyPolicy!: boolean;

  /** Honeypot — must be absent or empty */
  @IsOptional()
  @IsString()
  @MaxLength(0)
  _hp?: string;
}
