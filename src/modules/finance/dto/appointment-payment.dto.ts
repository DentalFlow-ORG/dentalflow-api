import { Transform } from 'class-transformer';
import {
  IsISO8601,
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
  MAX_MONEY_AMOUNT,
} from '../../../common/validators/input-validation.decorators';

export class AppointmentPaymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  appointmentId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @IsISO8601()
  paidAt?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(160)
  description?: string;
}
