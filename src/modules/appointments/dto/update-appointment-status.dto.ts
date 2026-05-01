import { AppointmentStatus, CanceledBy } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAppointmentStatusDto {
  @IsEnum(AppointmentStatus, { message: 'Status da consulta inválido' })
  status!: AppointmentStatus;

  @IsOptional()
  @IsEnum(CanceledBy, { message: 'Origem do cancelamento inválida' })
  canceledBy?: CanceledBy;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancellationReason?: string;
}
