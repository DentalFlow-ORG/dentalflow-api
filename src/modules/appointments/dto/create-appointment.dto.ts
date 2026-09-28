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
import { normalizePhone } from '../../../common/utils/transform.helpers';
import { BR_PHONE_DIGITS_PATTERN } from '../../../common/validators/br-field-patterns';

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
  patientUserId?: string;

  /**
   * Stable clinical identity of the person being booked.
   *
   * Sent when the operator picked an existing patient. When it is absent the
   * booking creates a new Patient. Contacts are attributes, never identity:
   * no existing Patient is inferred from name, email or phone.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  patientId?: string;

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

  // Masked input is accepted and stored as digits only (DDD + number), the
  // same canonical form as user and clinic phones. Formatting is presentation.
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @IsNotEmpty({ message: 'Informe um telefone com WhatsApp válido.' })
  @Matches(BR_PHONE_DIGITS_PATTERN, {
    message: 'Informe um telefone com WhatsApp válido.',
  })
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
