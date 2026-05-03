import { Transform } from 'class-transformer';
import {
  FinancialTransactionSource,
  FinancialTransactionStatus,
  FinancialTransactionType,
} from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class CreateFinancialTransactionDto {
  @IsEnum(FinancialTransactionType)
  type!: FinancialTransactionType;

  @IsOptional()
  @IsEnum(FinancialTransactionSource)
  source?: FinancialTransactionSource;

  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  description!: string;

  @IsString()
  @Matches(datePattern, { message: 'Data da transação deve estar no formato AAAA-MM-DD' })
  transactionDate!: string;

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
