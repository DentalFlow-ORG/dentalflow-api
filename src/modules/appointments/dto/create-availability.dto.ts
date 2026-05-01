import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const timePattern = /^\d{2}:\d{2}$/;

export class CreateAvailabilityDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @IsString()
  @Matches(timePattern, { message: 'Horário inicial deve estar no formato HH:mm' })
  startTime!: string;

  @IsString()
  @Matches(timePattern, { message: 'Horário final deve estar no formato HH:mm' })
  endTime!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
