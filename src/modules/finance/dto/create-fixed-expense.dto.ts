import { Transform } from 'class-transformer';
import { FixedExpenseRecurrence } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
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
  IsCalendarDate,
  IsSafeId,
  MAX_ID_LENGTH,
  MAX_MONEY_AMOUNT,
} from '../../../common/validators/input-validation.decorators';

export class CreateFixedExpenseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  description!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;

  @IsEnum(FixedExpenseRecurrence)
  recurrence!: FixedExpenseRecurrence;

  @IsInt()
  @Min(1)
  @Max(31)
  dueDay!: number;

  @IsString()
  @IsCalendarDate()
  startDate!: string;

  @IsOptional()
  @IsString()
  @IsCalendarDate()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
