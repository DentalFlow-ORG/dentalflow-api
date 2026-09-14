import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  IsSafeId,
  MAX_ID_LENGTH,
} from '../../../common/validators/input-validation.decorators';

export const STOCK_STATUS_VALUES = [
  'ACTIVE',
  'LOW',
  'EMPTY',
  'EXPIRING',
  'EXPIRED',
  'INACTIVE',
] as const;

export type StockProductStatus = (typeof STOCK_STATUS_VALUES)[number];

export class ListStockProductsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId?: string;

  @IsOptional()
  @IsIn(STOCK_STATUS_VALUES)
  status?: StockProductStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
