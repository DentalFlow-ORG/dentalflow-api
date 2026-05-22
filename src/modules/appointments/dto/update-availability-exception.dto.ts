import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsClockTime } from '../../../common/validators/input-validation.decorators';

export class UpdateAvailabilityExceptionDto {
  @IsOptional()
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

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
