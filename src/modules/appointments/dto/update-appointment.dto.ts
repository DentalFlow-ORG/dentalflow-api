import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

export class UpdateAppointmentDto {
  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @IsString()
  patientUserId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  patientName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  patientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  patientPhone?: string;

  @IsOptional()
  @IsString()
  @Matches(datePattern, { message: 'Data da consulta deve estar no formato AAAA-MM-DD' })
  appointmentDate?: string;

  @IsOptional()
  @IsString()
  @Matches(timePattern, { message: 'Horário da consulta deve estar no formato HH:mm' })
  startTime?: string;

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
}
