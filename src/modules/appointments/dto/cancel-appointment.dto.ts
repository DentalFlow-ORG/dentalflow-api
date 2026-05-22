import { CanceledBy } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelAppointmentDto {
  @IsOptional()
  @IsEnum(CanceledBy, { message: 'Origem do cancelamento invalida' })
  canceledBy?: CanceledBy;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancellationReason?: string;
}
