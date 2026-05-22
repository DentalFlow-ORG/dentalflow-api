import { Type } from 'class-transformer';
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
import {
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';
import {
  IsCalendarDate,
  IsSafeId,
  MAX_ID_LENGTH,
} from '../../../common/validators/input-validation.decorators';

export enum FinanceGroupByOption {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

export class FinancePeriodQueryDto {
  @IsOptional()
  @IsString()
  @IsCalendarDate()
  from?: string;

  @IsOptional()
  @IsString()
  @IsCalendarDate()
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
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
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

export class GenerateFixedExpenseOccurrenceQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Periodo deve estar no formato AAAA-MM',
  })
  period?: string;
}
