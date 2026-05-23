import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
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
} from '../../../common/validators/input-validation.decorators';

export class GetAvailableSlotsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  profileId!: string;

  @IsString()
  @IsCalendarDate()
  date!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(480)
  durationMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  serviceId?: string;
}
