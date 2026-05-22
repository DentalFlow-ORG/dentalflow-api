import { Transform } from 'class-transformer';
import {
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
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

export class CreateFinancialTransactionDto {
  @IsEnum(FinancialTransactionType)
  type!: FinancialTransactionType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  description!: string;

  @IsString()
  @IsCalendarDate()
  transactionDate!: string;

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
