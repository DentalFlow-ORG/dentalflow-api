import { Transform, Type } from 'class-transformer'
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator'
import {
  IsSafeId,
  MAX_ID_LENGTH,
} from '../../../common/validators/input-validation.decorators'
import { trimValue } from '../../../common/utils/transform.helpers'

export const STOCK_MOVEMENT_TYPE_VALUES = [
  'IN',
  'OUT',
  'ADJUSTMENT',
  'LOSS',
] as const

export type StockMovementTypeValue = (typeof STOCK_MOVEMENT_TYPE_VALUES)[number]

export class CreateStockMovementDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  productId!: string

  @IsIn(STOCK_MOVEMENT_TYPE_VALUES)
  type!: StockMovementTypeValue

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quantity?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  newQuantity?: number

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MaxLength(120)
  reason?: string

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MaxLength(2000)
  notes?: string
}
