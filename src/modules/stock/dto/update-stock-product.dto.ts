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
  IsOptionalButNotNull,
  IsSafeId,
  MAX_CENTS_AMOUNT,
  MAX_ID_LENGTH,
  MAX_STOCK_QUANTITY,
} from '../../../common/validators/input-validation.decorators';
import {
  blankToNull,
  blankToNullNumber,
  trimValue,
} from '../../../common/utils/transform.helpers';

// PATCH contract: an absent field is unchanged; `null` (or a blank string)
// clears description, supplier, notes, purchasePrice and expiresAt.
// minQuantity is a non-nullable column, so `null` resets it to 0.
const blank = ({ value }: { value: unknown }) => blankToNull(value);

export class UpdateStockProductDto {
  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptionalButNotNull()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId?: string;

  @Transform(blank)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  // Unit is required on the row (null is refused), so blank is refused too.
  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty({ message: 'Informe a unidade do produto.' })
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
  minQuantity?: number | null;

  // Blank means not set (null); the column is nullable, so never 0.
  @Transform(({ value }: { value: unknown }) => blankToNullNumber(value))
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS_AMOUNT, {
    message: 'Preço de compra deve ser no máximo R$ 9.999.999,99.',
  })
  purchasePrice?: number | null;

  @Transform(blank)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supplier?: string | null;

  @Transform(blank)
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @Transform(blank)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptionalButNotNull()
  @IsBoolean()
  isActive?: boolean;
}
