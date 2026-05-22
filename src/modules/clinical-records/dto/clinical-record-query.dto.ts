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
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  identifier!: string;
}
