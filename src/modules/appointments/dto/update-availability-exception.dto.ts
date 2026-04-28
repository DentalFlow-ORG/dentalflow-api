import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const timePattern = /^\d{2}:\d{2}$/;

export class UpdateAvailabilityExceptionDto {
  @IsOptional()
  @IsBoolean()
  isDayOff?: boolean;

  @IsOptional()
  @IsString()
  @Matches(timePattern, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(timePattern, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
