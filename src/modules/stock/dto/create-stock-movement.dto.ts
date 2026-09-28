import { Transform, Type } from 'class-transformer';
import {
  IsIn,
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
  MAX_ID_LENGTH,
  MAX_STOCK_QUANTITY,
} from '../../../common/validators/input-validation.decorators';
import { trimValue } from '../../../common/utils/transform.helpers';

export const STOCK_MOVEMENT_TYPE_VALUES = [
  'IN',
  'OUT',
  'ADJUSTMENT',
  'LOSS',
] as const;

export type StockMovementTypeValue =
  (typeof STOCK_MOVEMENT_TYPE_VALUES)[number];

export class CreateStockMovementDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  productId!: string;

  @IsIn(STOCK_MOVEMENT_TYPE_VALUES)
  type!: StockMovementTypeValue;

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
  quantity?: number;

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
  newQuantity?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MaxLength(120)
  reason?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
