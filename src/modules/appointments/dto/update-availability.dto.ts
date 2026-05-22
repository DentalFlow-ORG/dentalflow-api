import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { IsClockTime } from '../../../common/validators/input-validation.decorators';

export class UpdateAvailabilityDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @IsOptional()
  @IsString()
  @IsClockTime()
  startTime?: string;

  @IsOptional()
  @IsString()
  @IsClockTime()
  endTime?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
