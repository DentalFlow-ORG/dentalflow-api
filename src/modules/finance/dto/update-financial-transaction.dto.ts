import { Transform } from 'class-transformer';
import {
  FinancialTransactionSource,
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateFinancialTransactionDto {
  @IsOptional()
  @IsEnum(FinancialTransactionType)
  type?: FinancialTransactionType;

  @IsOptional()
  @IsEnum(FinancialTransactionSource)
  source?: FinancialTransactionSource;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
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
  @Matches(datePattern, { message: 'Data da transação deve estar no formato AAAA-MM-DD' })
  transactionDate?: string;

  @IsOptional()
  @IsString()
  @Matches(datePattern, { message: 'Data de vencimento deve estar no formato AAAA-MM-DD' })
  dueDate?: string;

  @IsOptional()
  @IsString()
  paidAt?: string;

  @IsOptional()
  @IsEnum(FinancialTransactionStatus)
  status?: FinancialTransactionStatus;
}
