import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const timePattern = /^\d{2}:\d{2}$/;

export class UpdateAvailabilityExceptionDto {
  @IsOptional()
  @IsBoolean()
  isDayOff?: boolean;

  @IsOptional()
  @IsString()
  @Matches(timePattern, { message: 'Horário inicial deve estar no formato HH:mm' })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(timePattern, { message: 'Horário final deve estar no formato HH:mm' })
  endTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
