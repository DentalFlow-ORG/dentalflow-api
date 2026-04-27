import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  IsInt,
  IsEmail,
} from 'class-validator';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

export class CreateAppointmentDto {
  @IsString()
  @IsNotEmpty()
  profileId!: string;

  @IsOptional()
  @IsString()
  serviceId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  patientUserId?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  patientName!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  patientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  patientPhone?: string;

  @IsString()
  @Matches(datePattern, { message: 'appointmentDate must be YYYY-MM-DD' })
  appointmentDate!: string;

  @IsString()
  @Matches(timePattern, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  durationMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  patientNotes?: string;
}
