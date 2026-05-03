import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import {
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export enum FinanceGroupByOption {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

export class FinancePeriodQueryDto {
  @IsOptional()
  @IsString()
  @Matches(datePattern, { message: 'Data inicial deve estar no formato AAAA-MM-DD' })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(datePattern, { message: 'Data final deve estar no formato AAAA-MM-DD' })
  to?: string;

  @IsOptional()
  @IsEnum(FinanceGroupByOption)
  groupBy?: FinanceGroupByOption;
}

export class ListFinancialTransactionsDto extends FinancePeriodQueryDto {
  @IsOptional()
  @IsEnum(FinancialTransactionType)
  type?: FinancialTransactionType;

  @IsOptional()
  @IsEnum(FinancialTransactionStatus)
  status?: FinancialTransactionStatus;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
