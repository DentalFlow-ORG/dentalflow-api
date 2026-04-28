import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

export class CreateAvailabilityExceptionDto {
  @IsString()
  @Matches(datePattern, { message: 'exceptionDate must be YYYY-MM-DD' })
  exceptionDate!: string;

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
