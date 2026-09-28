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
  blankToNull,
  normalizePhone,
} from '../../../common/utils/transform.helpers';
import { BR_PHONE_DIGITS_PATTERN } from '../../../common/validators/br-field-patterns';
import {
  IsCalendarDate,
  IsClockTime,
  IsOptionalButNotNull,
  IsSafeId,
  MAX_CENTS_AMOUNT,
  MAX_ID_LENGTH,
} from '../../../common/validators/input-validation.decorators';

/**
 * PATCH contract: an absent field is left unchanged. `null` clears the
 * optional fields serviceId, patientEmail, notes and estimatedAmountCents
 * (a blank email or note clears too). Required snapshot fields — patient name
 * and phone — and the schedule fields cannot be nulled.
 */
export class UpdateAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  serviceId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  @IsSafeId()
  patientUserId?: string;

  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Informe o nome do paciente.' })
  @MaxLength(100)
  patientName?: string;

  @Transform(({ value }: { value: unknown }) => blankToNull(value))
  @IsOptional()
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  @MaxLength(254)
  patientEmail?: string | null;

  // Stored as digits only; masked input is normalized first (see create DTO).
  @IsOptionalButNotNull()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @IsString()
  @Matches(BR_PHONE_DIGITS_PATTERN, {
    message: 'Informe um telefone com WhatsApp válido.',
  })
  patientPhone?: string;

  @IsOptionalButNotNull()
  @IsString()
  @IsCalendarDate()
  appointmentDate?: string;

  @IsOptionalButNotNull()
  @IsString()
  @IsClockTime()
  startTime?: string;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(5)
  @Max(480)
  durationMinutes?: number;

  @Transform(({ value }: { value: unknown }) => blankToNull(value))
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  patientNotes?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS_AMOUNT)
  estimatedAmountCents?: number | null;
}
