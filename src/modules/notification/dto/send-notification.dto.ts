import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const phonePattern = /^\d{10,11}$/;

function normalizePhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/\D/g, '');
}

export class SendNotificationDto {
  @IsString()
  @MaxLength(100)
  templateSlug!: string;

  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(phonePattern, {
    message:
      'Telefone deve ser um número brasileiro válido com DDD (10 ou 11 dígitos)',
  })
  phone!: string;

  @IsOptional()
  @IsString()
  appointmentId?: string;
}
