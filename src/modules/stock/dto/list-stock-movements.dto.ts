import { Type } from 'class-transformer'
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator'

import {
  STOCK_MOVEMENT_TYPE_VALUES,
  type StockMovementTypeValue,
} from './create-stock-movement.dto'

export class ListStockMovementsDto {
  @IsOptional()
  @IsString()
  productId?: string

  @IsOptional()
  @IsIn(STOCK_MOVEMENT_TYPE_VALUES)
  type?: StockMovementTypeValue

  @IsOptional()
  @IsDateString()
  dateFrom?: string

  @IsOptional()
  @IsDateString()
  dateTo?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number
}
