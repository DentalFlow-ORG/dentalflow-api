import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { LeadActivityAction } from '@prisma/client';

const MANUAL_ACTIONS: LeadActivityAction[] = [
  'NOTE_ADDED',
  'CONTACTED',
];

export class CreateLeadActivityDto {
  @IsEnum(MANUAL_ACTIONS, {
    message: 'Ação inválida. Use NOTE_ADDED ou CONTACTED',
  })
  @IsNotEmpty()
  action!: LeadActivityAction;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
