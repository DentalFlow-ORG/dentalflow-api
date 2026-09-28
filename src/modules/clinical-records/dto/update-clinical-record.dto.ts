import { normalizePhoneSnapshot } from '../../../common/utils/transform.helpers';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const CLINICAL_TEXT_MAX_LENGTH = 10_000;

export class UpdateClinicalRecordDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  patientName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  patientEmail?: string;

  @Transform(({ value }: { value: unknown }) => normalizePhoneSnapshot(value))
  @IsOptional()
  @IsString()
  @MaxLength(20)
  patientPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  chiefComplaint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLINICAL_TEXT_MAX_LENGTH)
  anamnesis?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLINICAL_TEXT_MAX_LENGTH)
  clinicalEvolution?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLINICAL_TEXT_MAX_LENGTH)
  diagnosis?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLINICAL_TEXT_MAX_LENGTH)
  proceduresPerformed?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLINICAL_TEXT_MAX_LENGTH)
  treatmentPlan?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLINICAL_TEXT_MAX_LENGTH)
  prescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLINICAL_TEXT_MAX_LENGTH)
  recommendations?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLINICAL_TEXT_MAX_LENGTH)
  privateNotes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CLINICAL_TEXT_MAX_LENGTH)
  aiDraft?: string;
}
