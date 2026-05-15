import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PrivacyRequestType, RequesterType } from '@prisma/client';
import { normalizeEmail, trimValue } from '../../../common/utils/transform.helpers';

export class CreatePrivacyRequestDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(150)
  requesterName!: string;

  @Transform(({ value }: { value: unknown }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  requesterEmail!: string;

  @IsEnum(RequesterType)
  requesterType!: RequesterType;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MaxLength(150)
  clinicName?: string;

  @IsEnum(PrivacyRequestType)
  requestType!: PrivacyRequestType;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  description!: string;

  @IsBoolean()
  identityConfirmationAccepted!: boolean;
}
