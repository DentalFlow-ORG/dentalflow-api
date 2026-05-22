import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LeadSource, LeadStatus } from '@prisma/client';
import {
  IsSafeId,
  MAX_ID_LENGTH,
} from '../../../common/validators/input-validation.decorators';

export class ListLeadsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(LeadStatus, { message: 'Status inválido' })
  status?: LeadStatus;

  @IsOptional()
  @IsEnum(LeadSource, { message: 'Origem inválida' })
  source?: LeadSource;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  assignedToUserId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : undefined))
  hasFollowUp?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 30;
}
