import { Type } from 'class-transformer';
import {
  IsDateString,
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

import {
  STOCK_MOVEMENT_TYPE_VALUES,
  type StockMovementTypeValue,
} from './create-stock-movement.dto';

export class ListStockMovementsDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  productId?: string;

  @IsOptional()
  @IsIn(STOCK_MOVEMENT_TYPE_VALUES)
  type?: StockMovementTypeValue;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

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
