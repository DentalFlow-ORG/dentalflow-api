import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator'

export const STOCK_STATUS_VALUES = [
  'ACTIVE',
  'LOW',
  'EMPTY',
  'EXPIRING',
  'EXPIRED',
  'INACTIVE',
] as const

export type StockProductStatus = (typeof STOCK_STATUS_VALUES)[number]

export class ListStockProductsDto {
  @IsOptional()
  @IsString()
  search?: string

  @IsOptional()
  @IsString()
  categoryId?: string

  @IsOptional()
  @IsIn(STOCK_STATUS_VALUES)
  status?: StockProductStatus

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
