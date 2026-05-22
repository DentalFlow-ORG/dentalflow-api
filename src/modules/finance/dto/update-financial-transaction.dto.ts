import { Transform } from 'class-transformer';
import {
  FinancialTransactionSource,
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  IsCalendarDate,
  IsSafeId,
  MAX_ID_LENGTH,
  MAX_MONEY_AMOUNT,
} from '../../../common/validators/input-validation.decorators';

export class UpdateFinancialTransactionDto {
  @IsOptional()
  @IsEnum(FinancialTransactionType)
  type?: FinancialTransactionType;

  @IsOptional()
  @IsEnum(FinancialTransactionSource)
  source?: FinancialTransactionSource;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(160)
  description?: string;

  @IsOptional()
  @IsString()
  @IsCalendarDate()
  transactionDate?: string;

  @IsOptional()
  @IsString()
  @IsCalendarDate()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @IsISO8601()
  paidAt?: string;

  @IsOptional()
  @IsEnum(FinancialTransactionStatus)
  status?: FinancialTransactionStatus;
}
