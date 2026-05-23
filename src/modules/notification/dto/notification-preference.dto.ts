import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdatePreferenceDto {
  @IsOptional()
  @IsBoolean()
  whatsappEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  autoReminder?: boolean;

  @IsOptional()
  @IsBoolean()
  autoConfirmation?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(72)
  reminderHoursBefore?: number;
}
