import { AppointmentStatus, CanceledBy } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAppointmentStatusDto {
  @IsEnum(AppointmentStatus)
  status!: AppointmentStatus;

  @IsOptional()
  @IsEnum(CanceledBy)
  canceledBy?: CanceledBy;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancellationReason?: string;
}
