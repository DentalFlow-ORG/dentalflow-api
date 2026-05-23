import { Transform } from 'class-transformer';
import { FixedExpenseRecurrence } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  IsCalendarDate,
  IsSafeId,
  MAX_ID_LENGTH,
  MAX_MONEY_AMOUNT,
} from '../../../common/validators/input-validation.decorators';

export class UpdateFixedExpenseDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(160)
  description?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount?: number;

  @IsOptional()
  @IsEnum(FixedExpenseRecurrence)
  recurrence?: FixedExpenseRecurrence;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay?: number;

  @IsOptional()
  @IsString()
  @IsCalendarDate()
  startDate?: string;

  @IsOptional()
  @IsString()
  @IsCalendarDate()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
