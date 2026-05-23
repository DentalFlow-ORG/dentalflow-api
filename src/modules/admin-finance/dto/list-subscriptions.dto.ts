import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SubscriptionStatus } from '@prisma/client';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListSubscriptionsDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsEnum(SubscriptionStatus, {
    message: 'status deve ser um valor válido de SubscriptionStatus',
  })
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  planId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'from deve ser uma data no formato YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'to deve ser uma data no formato YYYY-MM-DD' })
  to?: string;
}
