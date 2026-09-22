import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { trimValue } from '../../../common/utils/transform.helpers';

export class ListPatientsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class PatientHistoryQueryDto {
  /**
   * Stable clinical identity. Authoritative when present; `identifier` is the
   * compatibility fallback for clients that have not migrated yet.
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

export class PatientAvatarQueryDto {
  /**
   * Stable clinical identity. Authoritative when present; `identifier` is the
   * compatibility fallback for clients that have not migrated yet.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  patientId?: string;

  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  identifier!: string;
}
