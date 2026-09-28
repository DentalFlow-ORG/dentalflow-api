import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  IsSafeId,
  MAX_CENTS_AMOUNT,
  MAX_ID_LENGTH,
  MAX_STOCK_QUANTITY,
} from '../../../common/validators/input-validation.decorators';
import {
  blankToNullNumber,
  trimValue,
} from '../../../common/utils/transform.helpers';

export class CreateStockProductDto {
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 3 },
    { message: 'Quantidade deve ter no máximo 3 casas decimais.' },
  )
  @Min(0)
  @Max(MAX_STOCK_QUANTITY, {
    message: 'Quantidade deve ser no máximo 9.999.999,999.',
  })
  currentQuantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 3 },
    { message: 'Quantidade deve ter no máximo 3 casas decimais.' },
  )
  @Min(0)
  @Max(MAX_STOCK_QUANTITY, {
    message: 'Quantidade deve ser no máximo 9.999.999,999.',
  })
  minQuantity?: number;

  // Blank means not set (null); the column is nullable, so never 0.
  @Transform(({ value }: { value: unknown }) => blankToNullNumber(value))
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS_AMOUNT, {
    message: 'Preço de compra deve ser no máximo R$ 9.999.999,99.',
  })
  purchasePrice?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  supplier?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
