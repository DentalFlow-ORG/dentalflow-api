import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  ConsentSource,
  NotificationChannel,
  NotificationScope,
} from '@prisma/client';
import { normalizePhone } from '../../../common/utils/transform.helpers';
import { BR_PHONE_DIGITS_PATTERN } from '../../../common/validators/br-field-patterns';

export class CreateConsentDto {
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(BR_PHONE_DIGITS_PATTERN, {
    message:
      'Telefone deve ser um número brasileiro válido com DDD (10 ou 11 dígitos)',
  })
  phone!: string;

  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;

  @IsEnum(NotificationScope)
  scope!: NotificationScope;

  @IsBoolean()
  granted!: boolean;

  @IsEnum(ConsentSource)
  source!: ConsentSource;

  @IsOptional()
  @IsString()
  patientUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;
}

export class ListConsentsDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;

  @IsOptional()
  @IsEnum(NotificationScope)
  scope?: NotificationScope;
}
