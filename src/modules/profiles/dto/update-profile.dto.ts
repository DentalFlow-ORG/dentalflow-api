import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizePhone } from '../../../common/utils/transform.helpers';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const brPhonePattern = /^\d{10,11}$/;

export class UpdateProfileDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  displayName?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(60)
  @Matches(slugPattern, {
    message: 'slug must contain only lowercase letters, numbers, and hyphens',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  crmNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  crmState?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(brPhonePattern, { message: 'Telefone deve ser um número brasileiro válido com DDD e 10 ou 11 dígitos' })
  phone?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(brPhonePattern, { message: 'WhatsApp deve ser um número brasileiro válido com DDD e 10 ou 11 dígitos' })
  whatsappNumber?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  publicEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  instagramUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  facebookUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  websiteUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;
}
