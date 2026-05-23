import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  IsCalendarDate,
  IsClockTime,
  IsSafeId,
  MAX_CENTS_AMOUNT,
  MAX_ID_LENGTH,
} from '../../../common/validators/input-validation.decorators';

const phonePattern = /^\D*(?:\d\D*){10,11}$/;

export class CreateAppointmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  profileId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  serviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  leadId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
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

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Informe um telefone com WhatsApp valido.' })
  @Matches(phonePattern, {
    message: 'Informe um telefone com WhatsApp valido.',
  })
  @MaxLength(20)
  patientPhone!: string;

  @IsString()
  @IsCalendarDate()
  appointmentDate!: string;

  @IsString()
  @IsClockTime()
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

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS_AMOUNT)
  estimatedAmountCents?: number;
}
