import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { IsClockTime } from '../../../common/validators/input-validation.decorators';

export class CreateAvailabilityDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @IsString()
  @IsClockTime()
  startTime!: string;

  @IsString()
  @IsClockTime()
  endTime!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
