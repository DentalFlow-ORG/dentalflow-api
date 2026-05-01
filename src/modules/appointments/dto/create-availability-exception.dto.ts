import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

export class CreateAvailabilityExceptionDto {
  @IsString()
  @Matches(datePattern, { message: 'Data da exceção deve estar no formato AAAA-MM-DD' })
  exceptionDate!: string;

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
