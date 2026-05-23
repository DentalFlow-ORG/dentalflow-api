import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const CLINICAL_TEXT_MAX_LENGTH = 10_000;

export class CreateClinicalRecordDto {
  @IsOptional()
  @IsString()
  appointmentId?: string;

  @IsString()
  @IsNotEmpty()
  profileId!: string;

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
}
