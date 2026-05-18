import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  IsInt,
  IsEmail,
} from 'class-validator';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;
const phonePattern = /^\D*(?:\d\D*){10,11}$/;

export class CreateAppointmentDto {
  @IsString()
  @IsNotEmpty()
  profileId!: string;

  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  patientUserId?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  patientName!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  patientEmail?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Informe um telefone com WhatsApp válido.' })
  @Matches(phonePattern, {
    message: 'Informe um telefone com WhatsApp válido.',
  })
  @MaxLength(20)
  patientPhone!: string;

  @IsString()
  @Matches(datePattern, { message: 'Data da consulta deve estar no formato AAAA-MM-DD' })
  appointmentDate!: string;

  @IsString()
  @Matches(timePattern, { message: 'Horário da consulta deve estar no formato HH:mm' })
  startTime!: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  durationMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  patientNotes?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedAmountCents?: number;
}
