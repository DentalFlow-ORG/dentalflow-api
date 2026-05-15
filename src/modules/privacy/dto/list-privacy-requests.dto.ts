import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PrivacyRequestStatus, PrivacyRequestType, RequesterType } from '@prisma/client';

export class ListPrivacyRequestsDto {
  @IsOptional()
  @IsEnum(PrivacyRequestStatus)
  status?: PrivacyRequestStatus;

  @IsOptional()
  @IsEnum(PrivacyRequestType)
  requestType?: PrivacyRequestType;

  @IsOptional()
  @IsEnum(RequesterType)
  requesterType?: RequesterType;

  /** Matches requestCode, requesterEmail, or requesterName (case-insensitive, prefix). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value !== undefined ? Number(value) : undefined))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value !== undefined ? Number(value) : undefined))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
