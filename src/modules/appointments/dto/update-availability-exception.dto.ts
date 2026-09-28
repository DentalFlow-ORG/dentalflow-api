import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { blankToNull } from '../../../common/utils/transform.helpers';
import {
  IsClockTime,
  IsOptionalButNotNull,
} from '../../../common/validators/input-validation.decorators';

export class UpdateAvailabilityExceptionDto {
  @IsOptionalButNotNull()
  @IsBoolean()
  isDayOff?: boolean;

  @IsOptional()
  @IsString()
  @IsClockTime()
  startTime?: string;

  @IsOptional()
  @IsString()
  @IsClockTime()
  endTime?: string;

  // `null` (or a blank string) clears the reason; absent leaves it unchanged.
  @Transform(({ value }: { value: unknown }) => blankToNull(value))
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string | null;
}
