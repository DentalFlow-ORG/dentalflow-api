import { Transform } from 'class-transformer';
import { FinancialTransactionType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateFinancialCategoryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsEnum(FinancialTransactionType)
  type?: FinancialTransactionType;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  icon?: string;
}
