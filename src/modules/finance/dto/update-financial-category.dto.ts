import { Transform } from 'class-transformer';
import { FinancialTransactionType } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../../common/validators/input-validation.decorators';

export class UpdateFinancialCategoryDto {
  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'O nome da categoria é obrigatório.' })
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
