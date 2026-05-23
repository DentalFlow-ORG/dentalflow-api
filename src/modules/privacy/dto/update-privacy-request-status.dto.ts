import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrivacyRequestStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { trimValue } from '../../../common/utils/transform.helpers';

export class UpdatePrivacyRequestStatusDto {
  @IsEnum(PrivacyRequestStatus)
  status!: PrivacyRequestStatus;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trimValue(value))
  @IsString()
  @MaxLength(2000)
  responseNotes?: string;
}
