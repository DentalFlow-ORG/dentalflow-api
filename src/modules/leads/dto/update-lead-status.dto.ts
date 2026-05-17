import { IsEnum, IsNotEmpty } from 'class-validator';
import { LeadStatus } from '@prisma/client';

export class UpdateLeadStatusDto {
  @IsEnum(LeadStatus, { message: 'Status inválido' })
  @IsNotEmpty()
  status!: LeadStatus;
}
