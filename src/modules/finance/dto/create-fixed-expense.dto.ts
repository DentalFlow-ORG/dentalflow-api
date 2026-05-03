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
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class CreateFixedExpenseDto {
  @IsString()
  @IsNotEmpty()
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
  amount!: number;

  @IsEnum(FixedExpenseRecurrence)
  recurrence!: FixedExpenseRecurrence;

  @IsInt()
  @Min(1)
  @Max(31)
  dueDay!: number;

  @IsString()
  @Matches(datePattern, { message: 'Data inicial deve estar no formato AAAA-MM-DD' })
  startDate!: string;

  @IsOptional()
  @IsString()
  @Matches(datePattern, { message: 'Data final deve estar no formato AAAA-MM-DD' })
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
