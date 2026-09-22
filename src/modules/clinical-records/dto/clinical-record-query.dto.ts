import { ClinicalRecordStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { trimValue } from '../../../common/utils/transform.helpers';

export class ListClinicalRecordsQueryDto {
  @IsOptional()
  @IsEnum(ClinicalRecordStatus)
  status?: ClinicalRecordStatus;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  dentistProfileId?: string;
}

export class ClinicalIdentifierQueryDto {
  /**
   * Stable clinical identity. When present it is authoritative and
   * `identifier` is ignored. `identifier` remains only so an older frontend
   * keeps working during the migration; it resolves through the legacy
   * contact-matching path, which refuses ambiguous matches.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  patientId?: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  identifier!: string;
}
